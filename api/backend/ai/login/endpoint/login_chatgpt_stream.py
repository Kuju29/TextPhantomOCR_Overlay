"""Bounded decoder for first-party ChatGPT snapshot/v1 delta SSE.

No polling/reconnect is performed: an uncertain stream can never cause replay.
"""
from __future__ import annotations
import copy
import json


class StreamError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def bounded_structure(value):
    pending, visited = [(value, 0)], 0
    while pending:
        item, depth = pending.pop()
        visited += 1
        if depth > 64 or visited > 100000:
            raise StreamError('stream_too_large')
        if isinstance(item, dict):
            pending.extend((child, depth + 1) for child in item.values())
        elif isinstance(item, list):
            pending.extend((child, depth + 1) for child in item)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_sse_field')
        result[key] = value
    return result


class DeltaDecoder:
    def __init__(self):
        self.encoding: str | None = None
        self.previous = {'channel': 0, 'op': 'add', 'path': ''}
        self.values = {}

    def apply(self, item):
        if self.encoding != 'v1' or not isinstance(item, dict):
            raise StreamError('unsupported_delta_encoding')
        fields = {'c': 'channel', 'p': 'path', 'o': 'op', 'v': 'value'}
        expanded = {}
        for key, value in item.items():
            key = fields.get(key, key)
            if key in expanded or key not in {'channel', 'path', 'op', 'value'}:
                raise StreamError('invalid_delta')
            expanded[key] = value
        channel = expanded.get('channel', self.previous['channel'])
        path = expanded.get('path', self.previous['path'])
        op = expanded.get('op', self.previous['op'])
        if type(channel) is not int or not 0 <= channel < 32 or not isinstance(path, str) or len(path) > 4096 or not isinstance(op, str) or op not in {'add', 'remove', 'replace', 'append', 'truncate', 'patch'}:
            raise StreamError('invalid_delta')
        self.previous = {'channel': channel, 'path': path, 'op': op}
        root = copy.deepcopy(self.values.get(channel))
        root = self.operation(root, path, op, expanded.get('value'), has_value='value' in expanded)
        bounded_structure(root)
        if len(json.dumps(root, ensure_ascii=False)) > 8 * 1024 * 1024:
            raise StreamError('stream_too_large')
        self.values[channel] = root
        return copy.deepcopy(root)

    def operation(self, root, path, op, value, has_value=True, depth=0):
        if depth > 32:
            raise StreamError('invalid_delta')
        if op != 'remove' and not has_value:
            raise StreamError('delta_value_missing')
        if not isinstance(path, str) or len(path) > 4096 or (path and not path.startswith('/')):
            raise StreamError('invalid_delta_path')
        segments = [] if not path else [p.replace('~1', '/').replace('~0', '~') for p in path[1:].split('/')]
        if len(segments) > 32:
            raise StreamError('invalid_delta_path')
        def mutate(old):
            if op in {'add', 'replace'}:
                return copy.deepcopy(value)
            if op == 'remove':
                return None
            if op == 'append':
                if isinstance(old, str) and isinstance(value, str):
                    return old + value
                if isinstance(old, list):
                    return old + (copy.deepcopy(value) if isinstance(value, list) else [copy.deepcopy(value)])
                if isinstance(old, dict) and isinstance(value, dict):
                    return {**old, **copy.deepcopy(value)}
                return copy.deepcopy(value)
            if op == 'truncate':
                if type(value) is not int or value < 0 or not isinstance(old, (str, list)):
                    raise StreamError('invalid_delta_truncate')
                if isinstance(old, str):
                    # The first-party v1 decoder uses JS substring indices:
                    # UTF-16 units, including a temporarily split surrogate pair.
                    return old.encode('utf-16-le', 'surrogatepass')[:value * 2].decode('utf-16-le', 'surrogatepass')
                return old[:value]
            if op == 'patch':
                if not isinstance(value, list) or len(value) > 1024:
                    raise StreamError('invalid_delta_patch')
                for item in value:
                    if not isinstance(item, dict):
                        raise StreamError('invalid_delta_patch')
                    aliases = {'p': 'path', 'o': 'op', 'v': 'value'}
                    fields = {}
                    for key, val in item.items():
                        key = aliases.get(key, key)
                        if key in fields or key not in {'path', 'op', 'value'}:
                            raise StreamError('invalid_delta_patch')
                        fields[key] = val
                    if not {'path', 'op'} <= set(fields) or not isinstance(fields['op'], str) or fields['op'] not in {'add', 'remove', 'replace', 'append', 'truncate', 'patch'}:
                        raise StreamError('invalid_delta_patch')
                    old = self.operation(old, fields['path'], fields['op'], fields.get('value'), 'value' in fields, depth + 1)
                return old
            raise StreamError('invalid_delta')
        if not segments:
            return mutate(root)
        if root is None:
            root = [] if segments[0].isdigit() else {}
        target = root
        for index, key in enumerate(segments[:-1]):
            next_is_array = segments[index + 1].isdigit()
            if isinstance(target, list):
                if not key.isdigit() or not 0 <= int(key) < len(target):
                    raise StreamError('invalid_delta_path')
                target = target[int(key)]
            elif isinstance(target, dict):
                if key not in target:
                    target[key] = [] if next_is_array else {}
                target = target[key]
            else:
                raise StreamError('invalid_delta_path')
        key = segments[-1]
        if isinstance(target, list):
            if not key.isdigit():
                raise StreamError('invalid_delta_path')
            index = int(key)
            if op == 'add':
                if not 0 <= index <= len(target):
                    raise StreamError('invalid_delta_path')
                target.insert(index, copy.deepcopy(value))
            else:
                if not 0 <= index < len(target):
                    raise StreamError('invalid_delta_path')
                if op == 'remove':
                    target.pop(index)
                else:
                    target[index] = mutate(target[index])
        elif isinstance(target, dict):
            if op == 'remove':
                target.pop(key, None)
            else:
                target[key] = mutate(target.get(key))
        else:
            raise StreamError('invalid_delta_path')
        return root


class ConversationDecoder:
    def __init__(self, expected_conversation_id=''):
        self.conversation_id = expected_conversation_id
        self.assistant_id = None
        self.message = None
        self.delta = DeltaDecoder()
        self.done = False
        self.message_complete = False
        self.event_count = 0

    def event(self, event, raw):
        if event == 'ping':
            return
        if self.done:
            raise StreamError('event_after_done')
        if event == 'error':
            raise StreamError('provider_stream_error')
        self.event_count += 1
        if self.event_count > 100000:
            raise StreamError('stream_too_large')
        if raw == '[DONE]':
            self.done = True
            return
        try:
            data = json.loads(raw, object_pairs_hook=unique_object, parse_constant=lambda x: (_ for _ in ()).throw(ValueError('constant')))
        except (ValueError, RecursionError):
            if event == 'delta_encoding' and raw == 'v1':
                data = 'v1'
            else:
                raise StreamError('invalid_sse_json') from None
        bounded_structure(data)
        if event == 'delta_encoding':
            if self.delta.encoding is not None or data != 'v1':
                raise StreamError('unsupported_delta_encoding')
            self.delta.encoding = data
            return
        if event == 'delta':
            data = self.delta.apply(data)
        if not isinstance(data, dict):
            raise StreamError('invalid_sse_payload')
        if data.get('error') is not None:
            raise StreamError('provider_stream_error')
        cid = data.get('conversation_id')
        if cid is not None:
            if not isinstance(cid, str) or not cid or len(cid) > 128 or (self.conversation_id and cid != self.conversation_id):
                raise StreamError('conversation_binding_mismatch')
            self.conversation_id = cid
        if data.get('type') == 'moderation':
            moderation = data.get('moderation_response')
            if not isinstance(moderation, dict):
                raise StreamError('invalid_sse_payload')
            if moderation.get('blocked') is True:
                raise StreamError('provider_policy_refusal')
        if data.get('type') == 'message_stream_complete':
            self.message_complete = True
        message = data.get('message')
        if not isinstance(message, dict):
            return
        author = message.get('author')
        if not isinstance(author, dict):
            raise StreamError('invalid_sse_payload')
        if author.get('role') != 'assistant':
            return
        if message.get('channel') not in (None, 'final') or message.get('recipient') not in (None, 'all'):
            return
        mid = message.get('id')
        if not isinstance(mid, str) or not mid or len(mid) > 128 or (self.assistant_id is not None and mid != self.assistant_id):
            raise StreamError('assistant_binding_mismatch')
        metadata = message.get('metadata')
        if metadata is None:
            metadata = {}
        if not isinstance(metadata, dict):
            raise StreamError('provider_stream_error')
        finish = metadata.get('finish_details')
        if finish is not None and not isinstance(finish, dict):
            raise StreamError('provider_stream_error')
        if metadata.get('is_error') or metadata.get('error_metadata') or (finish or {}).get('type') in ('interrupted', 'content_filter'):
            raise StreamError('provider_stream_error')
        self.assistant_id, self.message = mid, copy.deepcopy(message)

    def result(self):
        if not self.done or not self.conversation_id or not self.message or self.message.get('status') != 'finished_successfully' or self.message.get('end_turn') is False:
            raise StreamError('stream_terminal_missing')
        content = self.message.get('content')
        if not isinstance(content, dict) or content.get('content_type') != 'text' or not isinstance(content.get('parts'), list) or any(not isinstance(part, str) for part in content['parts']):
            raise StreamError('unsupported_assistant_content')
        text = ''.join(content['parts'])
        try:
            # Delta boundaries may split a pair that a later append completes.
            # Never commit a final answer containing an unpaired surrogate.
            text = text.encode('utf-16-le', 'surrogatepass').decode('utf-16-le')
        except UnicodeError:
            raise StreamError('invalid_assistant_unicode') from None
        if not text.strip():
            raise StreamError('assistant_text_missing')
        return {'text': text, 'conversation_id': self.conversation_id, 'parent_message_id': self.assistant_id,
                'event_count': self.event_count, 'terminal_complete': True}


def decode_lines(lines, expected_conversation_id='', check=None):
    decoder = ConversationDecoder(expected_conversation_id)
    event, data, total = 'message', [], 0
    for line in lines:
        if check:
            check()
        if not isinstance(line, str):
            raise StreamError('invalid_sse_line')
        total += len(line.encode('utf-8'))
        if total > 8 * 1024 * 1024 or len(line) > 512 * 1024:
            raise StreamError('stream_too_large')
        if not line:
            if data:
                decoder.event(event, '\n'.join(data))
            elif event == 'error':
                decoder.event(event, '')
            event, data = 'message', []
        elif line.startswith(':'):
            continue
        elif line.startswith('event:'):
            event = line[6:].lstrip(' ')
        elif line.startswith('data:'):
            data.append(line[5:].lstrip(' '))
    if data or event != 'message':
        raise StreamError('unterminated_sse_event')
    return decoder.result()

"""Stateless System/User requests, with optional private accepted style examples."""

def execute(invoke, source, target_lang, ai, **kwargs):
    from backend.ai import wire_trace, trace_preview
    evidence = {"schema":"tp.conversation/1", "mode":"independent", "path":"independent",
        "phase":"prepared", "historyTurns":0, "historyMessages":0,
        "legacyFallback":False, "providerCallsAdded":0, "commitStatus":"not_applicable"}
    trace_preview.note("AI translation path", evidence)
    wire_trace.write_json("03_conversation_path.json", evidence)
    from .independent_examples import execution_scope, stage_result
    with execution_scope(ai, target_lang, kwargs.get('cancel_check')):
        result = invoke(source, target_lang, ai, **kwargs)
        stage_result(ai, target_lang, source, result)
        return result

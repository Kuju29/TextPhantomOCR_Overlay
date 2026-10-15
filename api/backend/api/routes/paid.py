"""Customer login and wallet gateway. The extension talks to its existing API."""
import httpx
import json
from threading import BoundedSemaphore
from fastapi import APIRouter, Request, Query, Path
from urllib.parse import urlencode
from fastapi.responses import JSONResponse, Response
from backend.paid_center import center_base_url, customer_request, center_response_id, center_response_meta, install_id, INSTALL_HEADER, CHANGES_HEADER, center_changes, valid_changes
from backend.gateway_proof import AUTH_PATHS
from backend import diagnostics
from backend.api.errors import ERROR_SCHEMA, failure_event, payload as error_payload, request_correlation

router = APIRouter()
_support_binary_slots = BoundedSemaphore(4)
# Long-poll passthrough: each wait holds one upstream connection for up to
# WAIT_SECONDS. Bound them so live chat can never exhaust sockets for other work.
_support_wait_slots = BoundedSemaphore(256)
WAIT_SECONDS = 25
WAIT_UPSTREAM_TIMEOUT = 35

@router.get("/paid/support")
@router.get("/paid/support/status")
@router.get("/paid/support/messages")
async def support_read(request: Request, after: int = Query(0, ge=0), before: int = Query(0, ge=0)):
    name = request.url.path.rsplit("/", 1)[-1]
    path = "/api/customer/support" + ("/" + name if name != "support" else "")
    if name == "messages":
        path += "?" + urlencode({"after": after, "before": before})
    return await forward(path, request=request)

@router.get("/paid/support/wait")
async def support_wait(request: Request, after: int = Query(0, ge=0), version: int = Query(0, ge=0),
                       timeout: int = Query(WAIT_SECONDS, ge=0, le=WAIT_SECONDS)):
    """Near-real-time chat: Center answers as soon as the conversation changes or
    after ``timeout`` seconds. Async I/O only; other requests are never blocked."""
    if not _support_wait_slots.acquire(blocking=False):
        return JSONResponse({"error": {"code": "SUPPORT_WAIT_BUSY", "message": "Live chat is busy; retry shortly"}}, 429,
                            headers={"Retry-After": "5", "Cache-Control": "no-store"})
    try:
        path = "/api/customer/support/wait?" + urlencode({"after": after, "version": version, "timeout": timeout})
        return await forward(path, request=request, timeout=WAIT_UPSTREAM_TIMEOUT)
    finally:
        _support_wait_slots.release()

@router.post("/paid/support/messages")
@router.post("/paid/support/action")
@router.post("/paid/support/presence")
async def support_write(request: Request):
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > 32 * 1024:
            return JSONResponse({"error": {"code": "BODY_TOO_LARGE", "message": "Message exceeds size limit"}}, 413)
        raw.extend(chunk)
    try:
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError("Invalid message")
    except (ValueError, UnicodeError):
        return JSONResponse({"error": {"code": "INVALID_MESSAGE", "message": "Invalid message"}}, 422)
    name = request.url.path.rsplit("/", 1)[-1]
    return await forward("/api/customer/support/" + name, method="POST", body=payload, request=request)

async def support_binary(path, request, *, upload=False):
    if not _support_binary_slots.acquire(blocking=False):
        return JSONResponse({"error": {"code": "SUPPORT_BUSY", "message": "Attachments are busy; retry the same request"}}, 429,
                            headers={"Retry-After": "5", "Cache-Control": "no-store"})
    try:
        return await _support_binary(path, request, upload=upload)
    finally:
        _support_binary_slots.release()

async def _support_binary(path, request, *, upload=False):
    from backend.paid_center import require_center, center_origin
    try:
        base = require_center()
    except RuntimeError:
        return JSONResponse({"error": {"code": "SUPPORT_UNAVAILABLE", "message": "Support unavailable"}}, 404)
    header = request.headers.get("Authorization", "")
    import re
    if not re.fullmatch(r"Bearer [A-Za-z0-9_-]{40,100}", header):
        return JSONResponse({"error": {"code": "AUTH_REQUIRED", "message": "Sign in to contact support"}}, 401)
    headers = {"Accept": "application/octet-stream", **diagnostics.headers()}
    if header.startswith("Bearer "):
        headers["Authorization"] = header
    if install := install_id(request.headers.get(INSTALL_HEADER)):
        headers[INSTALL_HEADER] = install
    raw = b""
    if upload:
        # A syntactically valid fake token must not buy a 20 MiB buffer.
        try:
            status, state = await customer_request("/api/customer/support", bearer=header[7:])
        except (httpx.HTTPError, TimeoutError, ValueError):
            return JSONResponse({"error": {"code": "SUPPORT_UNAVAILABLE", "message": "Support unavailable"}}, 503)
        if status != 200:
            return JSONResponse(customer_payload(state, status), status)
        if not isinstance(state, dict) or type(state.get("max_file_mb")) is not int or not 1 <= state["max_file_mb"] <= 20:
            return JSONResponse({"error": {"code": "SUPPORT_UNAVAILABLE", "message": "Support unavailable"}}, 503)
        if state.get("enabled") is not True:
            return JSONResponse({"error": {"code": "SUPPORT_DISABLED", "message": "Support is currently unavailable"}}, 409)
        cap = state["max_file_mb"] * 1024 * 1024
        try:
            if int(request.headers.get("Content-Length", "0")) > cap:
                return JSONResponse({"error": {"code": "FILE_TOO_LARGE", "message": "File exceeds upload limit"}}, 413)
        except ValueError:
            return JSONResponse({"error": {"code": "INVALID_FILE", "message": "Invalid file request"}}, 422)
        headers.update({"Origin": center_origin(), "Content-Type": "application/octet-stream",
                       "X-File-Name": request.headers.get("X-File-Name", ""),
                       "X-Command-ID": request.headers.get("X-Command-ID", "")})
        content = bytearray()
        async for chunk in request.stream():
            if len(content) + len(chunk) > cap:
                return JSONResponse({"error": {"code": "FILE_TOO_LARGE", "message": "File exceeds upload limit"}}, 413)
            content.extend(chunk)
        raw = bytes(content)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(45, connect=4), follow_redirects=False, trust_env=False) as client:
            async with client.stream("POST" if upload else "GET", base + path, headers=headers, content=raw if upload else None) as response:
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    if len(body) + len(chunk) > (256 * 1024 if upload or response.status_code != 200 else 20 * 1024 * 1024):
                        raise ValueError("Invalid support response size")
                    body.extend(chunk)
                if response.status_code >= 400 or upload:
                    import json
                    payload = json.loads(body)
                    if not isinstance(payload, dict):
                        raise ValueError("Invalid support response envelope")
                    relayed = {"Cache-Control": "no-store"}
                    if changes := valid_changes(response.headers.get("x-tp-changes", "")):
                        relayed[CHANGES_HEADER] = changes
                    return JSONResponse(customer_payload(payload, response.status_code), response.status_code, headers=relayed)
                if response.status_code != 200:
                    raise ValueError("Support redirects are forbidden")
                safe = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}
                for key in ("Content-Type", "Content-Disposition"):
                    if value := response.headers.get(key):
                        safe[key] = value
                if changes := valid_changes(response.headers.get("x-tp-changes", "")):
                    safe[CHANGES_HEADER] = changes
                return Response(bytes(body), headers=safe)
    except (httpx.HTTPError, TimeoutError, ValueError):
        return JSONResponse({"error": {"code": "SUPPORT_UNAVAILABLE", "message": "Support unavailable; retry the same request"}}, 503)

@router.post("/paid/support/attachments")
async def support_upload(request: Request):
    return await support_binary("/api/customer/support/attachments", request, upload=True)

@router.get("/paid/support/attachments/{identifier}")
async def support_download(identifier: str, request: Request):
    import re
    if not re.fullmatch(r"att_[a-f0-9]{32}", identifier):
        return JSONResponse({"error": {"code": "NOT_FOUND", "message": "Not found"}}, 404)
    return await support_binary("/api/customer/support/attachments/" + identifier, request)


_SERVICE_MESSAGES = {
    'OTP_DISABLED': 'ระบบส่งรหัสยังไม่เปิดใช้งาน',
    'EMAIL_NOT_CONFIGURED': 'ระบบอีเมลยังไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง',
    'CUSTOMER_ACCESS_UNAVAILABLE': 'บริการบัญชียังไม่พร้อมใช้งาน',
    'GATEWAY_IDENTITY_INVALID': 'บริการยืนยันการเชื่อมต่อไม่ได้ กรุณาลองใหม่ภายหลัง',
    'PURCHASE_UNAVAILABLE': 'ยังไม่เปิดรับซื้อเครดิต',
    'STRIPE_PAYMENT_UNAVAILABLE': 'ยังไม่เปิดรับชำระเงิน',
    'REFUND_NOT_CONFIGURED': 'บริการคืนเงินไม่พร้อมชั่วคราว กรุณาติดต่อฝ่ายสนับสนุน',
    'REFUND_CREDENTIAL_UNAVAILABLE': 'บริการคืนเงินไม่พร้อมชั่วคราว กรุณาติดต่อฝ่ายสนับสนุน',
    'AI_NOT_CONFIGURED': 'บริการแปล Paid ยังไม่เปิดใช้งาน',
    'PAID_PAUSED': 'บริการแปล Paid พักชั่วคราว กรุณาลองใหม่ภายหลัง',
    'MODEL_PRICE_UNVERIFIED': 'โมเดล Paid นี้ยังไม่พร้อมใช้งาน',
    'PAID_PRICE_REFRESHING': 'กำลังตรวจราคาช่องทางแปล กรุณารอสักครู่ ยังไม่เริ่มแปลและไม่จองเครดิต',
    'PAID_ROUTE_UNAVAILABLE': 'ยังไม่มีช่องทางที่ยืนยันราคาและรองรับตัวเลือกนี้ กรุณาตรวจโมเดลหรือตัวเลือกการแปล',
    'PAID_QUOTE_STALE': 'ราคาหรือตัวเลือกเปลี่ยน กรุณาตรวจราคาอีกครั้ง ยังไม่เริ่มแปลและไม่จองเครดิต',
    'PAID_QUOTE_PRICE_CHANGED': 'ราคาช่องทางเปลี่ยนจากที่ตรวจไว้ กรุณาเริ่มงานใหม่เพื่อตรวจราคา ยังไม่เริ่มแปลและไม่จองเครดิต',
    'PAID_QUOTE_REQUIRED': 'กรุณาอัปเดตส่วนขยายและตรวจราคาก่อนแปล',
    'PAID_THINKING_UNVERIFIED': 'ยังตรวจสอบ Thinking ของโมเดล Paid นี้ไม่ได้',
}

# A quote reads metadata before any AI dispatch or credit hold. Its failure
# diagnostic must remain useful when file logging is off, without reflecting
# arbitrary upstream codes, messages, HTML or configuration into the console.
_PRICE_QUOTE_MESSAGES = {
    **_SERVICE_MESSAGES,
    'AUTH_REQUIRED': 'กรุณาเข้าสู่ระบบ Paid อีกครั้ง',
    'ORIGIN_REJECTED': 'คำขอนี้ไม่ผ่านการตรวจสอบ กรุณาเปิดหน้าบริการใหม่',
    'MODEL_NOT_ALLOWED': 'โมเดลนี้ยังไม่เปิดให้ใช้ กรุณาเลือกโมเดลอื่น',
    'PAID_OUTPUT_UNSUPPORTED': 'โมเดลนี้ยังไม่รองรับขนาดคำตอบที่เลือก',
    'PAID_IMAGE_UNSUPPORTED': 'โมเดลนี้ยังไม่รองรับภาพสำหรับคำขอนี้',
    'PAID_THINKING_UNSUPPORTED': 'โมเดลนี้ไม่รองรับระดับ Thinking ที่เลือก',
    'REASONING_INVALID': 'ตัวเลือก Thinking ไม่ถูกต้อง กรุณาตรวจตัวเลือกการแปล',
    'PAID_UNAVAILABLE': 'บริการ Paid ยังไม่พร้อมใช้งาน',
    'CENTER_UNAVAILABLE': 'ติดต่อ Center ไม่ได้ กรุณาลองใหม่ภายหลัง',
    'CENTER_RESPONSE_INVALID': 'Center ตอบไม่ถูกต้อง กรุณาติดต่อฝ่ายสนับสนุนพร้อมรหัสอ้างอิง',
    'CENTER_HTTP_ERROR': 'บริการตรวจราคาไม่พร้อม กรุณาติดต่อฝ่ายสนับสนุนพร้อมรหัสอ้างอิง',
    'PAID_NOT_CONFIGURED': 'Paid ไม่ได้เปิดบน API นี้',
}
_CENTER_ERROR_TYPES = {
    'HTTPError', 'TimeoutError', 'TimeoutException', 'ConnectTimeout', 'ReadTimeout',
    'WriteTimeout', 'PoolTimeout', 'ConnectError', 'ReadError', 'WriteError', 'CloseError',
    'NetworkError', 'ProxyError', 'UnsupportedProtocol', 'LocalProtocolError',
    'RemoteProtocolError', 'HTTPStatusError', 'TooManyRedirects', 'DecodingError',
    'JSONDecodeError', 'ValueError',
}


def price_quote_failure(payload, status, request):
    """Preserve the customer error envelope while classifying this read-only call."""
    error = payload.get('error') if isinstance(payload, dict) else None
    error = error if isinstance(error, dict) else {}
    raw_code = error.get('code')
    code = raw_code if isinstance(raw_code, str) and raw_code in _PRICE_QUOTE_MESSAGES else 'CENTER_HTTP_ERROR'
    info = center_response_meta.get() or {}
    kind = info.get('response_kind')
    kind = kind if kind in {'transport', 'json', 'non_json', 'non_object'} else 'json'
    upstream = info.get('upstream_status') if kind != 'transport' else None
    upstream = upstream if type(upstream) is int and 100 <= upstream <= 599 else None
    error_type = info.get('error_type')
    error_type = error_type if error_type in _CENTER_ERROR_TYPES else None
    reference = center_response_id.get() or diagnostics.valid_id(error.get('request_id'))
    extra = {'responseKind': kind, 'providerAttempts': 0, 'generationAttempts': 0,
             'requestDispatched': False}
    if error_type:
        extra['errorType'] = error_type
    if reference:
        extra.update(centerRequestId=reference, request_id=reference)
    detail = error_payload(
        code=code, message=_PRICE_QUOTE_MESSAGES[code], user_message=_PRICE_QUOTE_MESSAGES[code],
        origin='api' if code == 'PAID_NOT_CONFIGURED' else 'control_center', stage='paid_price_quote',
        category='configuration' if code == 'PAID_NOT_CONFIGURED' else 'availability' if status >= 500 else 'admission',
        retryable=status in {408, 425, 429, 500, 502, 503, 504}, http_status=status,
        upstream_status=upstream,
        trace_id=diagnostics.valid_id(request.headers.get('x-tp-trace-id')) if request else '',
        correlation=request_correlation(request) if request else {}, extra=extra,
    )
    failure_event('/paid/price-quote', detail, responseKind=kind,
                  errorType=error_type, centerRequestId=reference)
    headers = {'Cache-Control': 'no-store', 'X-TP-Error-Schema': ERROR_SCHEMA}
    if reference:
        headers['X-TP-Center-Request-ID'] = reference
    return JSONResponse({'error': detail}, status_code=status, headers=headers)


def customer_payload(payload, status):
    """Keep actionable customer errors while hiding operator configuration."""
    error = payload.get('error') if isinstance(payload.get('error'), dict) else None
    if not error:
        return payload
    code = str(error.get('code') or '')
    message = _SERVICE_MESSAGES.get(code)
    if message is None and status >= 500:
        message = 'บริการไม่พร้อมชั่วคราว กรุณาติดต่อฝ่ายสนับสนุนพร้อมรหัสอ้างอิง'
    if message is None:
        return payload
    public = {'code': code, 'message': message}
    if reference := diagnostics.valid_id(error.get('request_id')):
        public['request_id'] = reference
    # Configuration/provider details are support-only. No authorization or
    # wallet evidence is inferred from removing presentation metadata.
    return {**payload, 'error': public}


# Signed "client address unknown" marker for Center (the unspecified address).
# Center then applies no per-IP OTP/sign-in/Trial throttle to this request and
# keys those limits on the install id and email instead. Sent whenever the API
# cannot prove the caller's address: on a HF Space every request arrives from
# the platform proxy, and forwarding that one address made Center's per-IP
# limits global across all users.
UNKNOWN_PEER = "::"


def gateway_peer(request):
    from backend.api.ingress import trusted_client_ip
    host = request.client.host if request is not None and request.client else None
    return trusted_client_ip(host) or UNKNOWN_PEER


async def forward(path, *, method="GET", body=None, request=None, timeout=15):
    center_response_id.set("")
    center_response_meta.set(None)
    center_changes.set("")
    if not center_base_url():
        diagnostics.emit("paid.forward.rejected", outcome="rejected", error_code="PAID_NOT_CONFIGURED", path=path)
        if path == '/api/customer/price-quote':
            return price_quote_failure({'error': {'code': 'PAID_NOT_CONFIGURED'}}, 404, request)
        return JSONResponse({"error": {"code": "PAID_NOT_CONFIGURED", "message": "Paid ไม่ได้เปิดบน API นี้"}}, 404, headers={"Cache-Control": "no-store"})
    header = request.headers.get("Authorization", "") if request else ""
    bearer = header[7:] if header.startswith("Bearer ") else ""
    try:
        options = {"peer": gateway_peer(request)} if request is not None and path in AUTH_PATHS else {}
        if timeout != 15:
            options["timeout"] = timeout
        # Only a valid install id (32 lowercase hex) is forwarded; nothing else from the client.
        if request is not None and (install := install_id(request.headers.get(INSTALL_HEADER))):
            options["install"] = install
        status, payload = await customer_request(path, method=method, body=body, bearer=bearer, **options)
    except (httpx.HTTPError, TimeoutError) as exc:
        diagnostics.emit("paid.forward.failed", outcome="error", error_code="CENTER_UNAVAILABLE", path=path, **diagnostics.fault(exc))
        if path == '/api/customer/price-quote':
            center_response_meta.set({'response_kind': 'transport', 'error_type': type(exc).__name__})
            return price_quote_failure({'error': {'code': 'CENTER_UNAVAILABLE'}}, 503, request)
        return JSONResponse({"error": {"code": "CENTER_UNAVAILABLE", "message": "ติดต่อ Center ไม่ได้"}}, 503, headers={"Cache-Control": "no-store"})
    if path == '/api/customer/price-quote' and status >= 400:
        return price_quote_failure(payload, status, request)
    headers = {"Cache-Control": "no-store"}
    payload = customer_payload(payload, status)
    if path == '/api/customer/auth/status' and status == 200:
        verified = (payload.get('client_identity') or {}).get('verified_gateway') is True
        payload['client_identity'] = {'ready': verified,
            'code': 'SIGNED_GATEWAY' if verified else 'GATEWAY_IDENTITY_NOT_CONFIGURED',
            'message': 'บริการยืนยันการเชื่อมต่อแล้ว' if verified else
                'บริการกำลังเตรียมความพร้อม'}
        if payload.get('code') in _SERVICE_MESSAGES:
            payload['message'] = _SERVICE_MESSAGES[payload['code']]
    if center_response_id.get(): headers["X-TP-Center-Request-ID"] = center_response_id.get()
    # The customer's change tokens ride on the response the extension already gets.
    if center_changes.get(): headers[CHANGES_HEADER] = center_changes.get()
    return JSONResponse(payload, status_code=status, headers=headers)


@router.post("/paid/auth/request")
async def request_otp(payload: dict, request: Request):
    return await forward("/api/customer/auth/request", method="POST", body=payload, request=request)


@router.get("/paid/auth/status")
async def auth_status(request: Request):
    return await forward("/api/customer/auth/status", request=request)


@router.post("/paid/auth/verify")
async def verify_otp(payload: dict, request: Request):
    return await forward("/api/customer/auth/verify", method="POST", body=payload, request=request)


@router.get("/paid/me")
async def me(request: Request):
    return await forward("/api/customer/me", request=request)


@router.post('/paid/price-quote')
async def price_quote(payload: dict, request: Request):
    # Center validates options and issues an account-scoped, short-lived quote.
    # This endpoint reads metadata only, never dispatches AI or changes credits.
    return await forward('/api/customer/price-quote', method='POST', body=payload, request=request)


@router.post("/paid/auth/logout")
async def logout(request: Request):
    return await forward("/api/customer/auth/logout", method="POST", body={}, request=request)


@router.get("/paid/account")
async def account(request: Request):
    return await forward("/api/customer/account", request=request)


@router.get("/paid/history")
async def history(request: Request, kind: str = Query("orders", pattern=r"^(orders|payments|usage|lots|ledger|refunds)$"),
                  ledger_filter: str = Query("all", pattern=r"^(all|added|used|admin|expired)$"),
                  offset: int = Query(0, ge=0, le=100000), limit: int = Query(25, ge=1, le=100)):
    return await forward("/api/customer/history?"+urlencode({"kind":kind,"offset":offset,"limit":limit,**({"ledger_filter":ledger_filter} if kind=="ledger" else {})}), request=request)


@router.post("/paid/orders")
async def create_order(payload: dict, request: Request):
    return await forward("/api/customer/orders", method="POST", body=payload, request=request)


@router.get("/paid/addons")
async def addons(request: Request):
    return await forward("/api/customer/addons", request=request)


@router.post("/paid/addon-orders")
async def addon_order(payload: dict, request: Request):
    return await forward("/api/customer/addon-orders", method="POST", body=payload, request=request)


@router.get("/paid/addon-orders/{order_id}")
async def addon_order_get(request: Request, order_id: str = Path(pattern=r"^ado_[a-f0-9]{32}$")):
    return await forward("/api/customer/addon-orders/"+order_id, request=request)


@router.post("/paid/addon-orders/{order_id}/action")
async def addon_order_action(payload: dict, request: Request, order_id: str = Path(pattern=r"^ado_[a-f0-9]{32}$")):
    return await forward("/api/customer/addon-orders/"+order_id+"/action", method="POST", body=payload, request=request)


@router.get("/paid/orders/{order_id}")
async def get_order(request: Request, order_id: str = Path(pattern=r"^ord_[a-f0-9]{32}$")):
    return await forward("/api/customer/orders/"+order_id, request=request)


@router.post("/paid/orders/{order_id}/action")
async def order_action(payload: dict, request: Request, order_id: str = Path(pattern=r"^ord_[a-f0-9]{32}$")):
    return await forward("/api/customer/orders/"+order_id+"/action", method="POST", body=payload, request=request)


@router.post("/paid/refunds")
async def create_refund(payload: dict, request: Request):
    return await forward("/api/customer/refunds", method="POST", body=payload, request=request)

"""Customer login and wallet gateway. The extension talks to its existing API."""
import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from backend.paid_center import center_base_url, customer_request

router = APIRouter()


async def forward(path, *, method="GET", body=None, request=None):
    if not center_base_url():
        return JSONResponse({"error": {"code": "PAID_NOT_CONFIGURED", "message": "Paid ไม่ได้เปิดบน API นี้"}}, 404)
    header = request.headers.get("Authorization", "") if request else ""
    bearer = header[7:] if header.startswith("Bearer ") else ""
    try:
        status, payload = await customer_request(path, method=method, body=body, bearer=bearer)
    except (httpx.HTTPError, TimeoutError):
        return JSONResponse({"error": {"code": "CENTER_UNAVAILABLE", "message": "ติดต่อ Center ไม่ได้"}}, 503)
    return JSONResponse(payload, status_code=status, headers={"Cache-Control": "no-store"})


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


@router.post("/paid/auth/logout")
async def logout(request: Request):
    return await forward("/api/customer/auth/logout", method="POST", body={}, request=request)

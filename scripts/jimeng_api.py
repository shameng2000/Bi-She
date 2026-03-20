import base64
import datetime
import hashlib
import hmac
import json
import os
import re
import time
import urllib.parse
import urllib.request


def get_env(name, default=None):
    value = os.getenv(name, default)
    if value is None or value == "":
        return default
    return value


def _hash_sha256(content):
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _hmac_sha256(key, msg):
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _encode(value):
    return urllib.parse.quote(str(value), safe="-_.~")


def _canonical_querystring(query):
    items = sorted((str(k), str(v)) for k, v in (query or {}).items())
    return "&".join([f"{_encode(k)}={_encode(v)}" for k, v in items])


def _canonical_headers(headers):
    items = []
    for k, v in headers.items():
        key = k.lower().strip()
        val = " ".join(str(v).strip().split())
        items.append((key, val))
    items.sort(key=lambda x: x[0])
    canonical = "\n".join([f"{k}:{v}" for k, v in items]) + "\n"
    signed = ";".join([k for k, _ in items])
    return canonical, signed


def sign_v4(method, path, query, headers, body, ak, sk, region, service, token=None):
    now = datetime.datetime.utcnow()
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")

    payload_hash = _hash_sha256(body)
    headers["X-Date"] = amz_date
    headers["X-Content-Sha256"] = payload_hash
    if token:
        headers["X-Security-Token"] = token

    canonical_query = _canonical_querystring(query)
    canonical_headers, signed_headers = _canonical_headers(headers)
    canonical_request = "\n".join(
        [
            method,
            path,
            canonical_query,
            canonical_headers,
            signed_headers,
            payload_hash,
        ]
    )

    credential_scope = f"{date_stamp}/{region}/{service}/request"
    string_to_sign = "\n".join(
        [
            "HMAC-SHA256",
            amz_date,
            credential_scope,
            _hash_sha256(canonical_request),
        ]
    )

    k_date = _hmac_sha256(("AWS4" + sk).encode("utf-8"), date_stamp)
    k_region = hmac.new(k_date, region.encode("utf-8"), hashlib.sha256).digest()
    k_service = hmac.new(k_region, service.encode("utf-8"), hashlib.sha256).digest()
    k_signing = hmac.new(k_service, b"request", hashlib.sha256).digest()
    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    headers["Authorization"] = (
        f"HMAC-SHA256 Credential={ak}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )

    return headers


def raw_request(action, version, body_dict, method="POST"):
    ak = get_env("VOLC_ACCESS_KEY")
    sk = get_env("VOLC_SECRET_KEY")
    if not ak or not sk:
        raise RuntimeError("VOLC_ACCESS_KEY / VOLC_SECRET_KEY 未配置")

    region = get_env("VOLC_REGION", "cn-north-1")
    host = get_env("VOLC_HOST", "open.volcengineapi.com")
    token = get_env("VOLC_SESSION_TOKEN")

    query = {"Action": action, "Version": version}
    body = json.dumps(body_dict, ensure_ascii=False)
    headers = {"Host": host, "Content-Type": "application/json; charset=utf-8"}

    sign_v4(method, "/", query, headers, body, ak, sk, region, "cv", token)
    url = "https://%s/?%s" % (host, urllib.parse.urlencode(query))
    data = body.encode("utf-8")

    req = urllib.request.Request(url, data=data, method=method)
    for k, v in headers.items():
        req.add_header(k, v)

    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw)


def submit_task(_api, prompt, req_key, extra=None):
    payload = {"req_key": req_key, "prompt": prompt}
    if isinstance(extra, dict):
        payload.update(extra)
    return raw_request(
        action=get_env("JIMENG_SUBMIT_ACTION", "JimengT2IV40SubmitTask"),
        version=get_env("JIMENG_SUBMIT_VERSION", "2024-06-06"),
        body_dict=payload,
        method="POST",
    )


def query_task(_api, task_id, req_key):
    return raw_request(
        action=get_env("JIMENG_QUERY_ACTION", "CVSync2AsyncGetResult"),
        version=get_env("JIMENG_QUERY_VERSION", "2022-08-31"),
        body_dict={"req_key": req_key, "task_id": task_id},
        method="POST",
    )


def extract_data(resp):
    if not isinstance(resp, dict):
        return {}
    result = resp.get("Result") or resp.get("result")
    if isinstance(result, dict):
        data = result.get("data") or result.get("Data")
        if isinstance(data, dict):
            return data
    data = resp.get("data")
    if isinstance(data, dict):
        return data
    return resp


def clean_b64(raw_b64):
    if not raw_b64:
        return None
    if raw_b64.startswith("data:"):
        raw_b64 = raw_b64.split(",", 1)[-1]
    raw_b64 = re.sub(r"\s+", "", raw_b64)
    return raw_b64


def save_image(raw_b64, out_path):
    raw_b64 = clean_b64(raw_b64)
    if not raw_b64:
        return False
    data = base64.b64decode(raw_b64)
    with open(out_path, "wb") as f:
        f.write(data)
    return True


def main():
    raw_input = sys.stdin.read()
    payload = {}
    if raw_input.strip():
        payload = json.loads(raw_input)

    prompt = payload.get("prompt") or get_env("JIMENG_PROMPT")
    req_key = payload.get("req_key") or get_env("JIMENG_REQ_KEY", "jimeng_t2i_v40")
    poll_interval = int(payload.get("poll_interval") or 5)
    poll_limit = int(payload.get("poll_limit") or 24)
    extra = payload.get("extra") or payload.get("options") or {}
    if isinstance(payload.get("force_single"), bool):
        extra["force_single"] = payload.get("force_single")

    if not prompt:
        raise RuntimeError("prompt is required")
    prompt = str(prompt).encode("utf-8", "replace").decode("utf-8")

    submit_resp = submit_task(None, prompt, req_key, extra)
    data = extract_data(submit_resp)
    task_id = data.get("task_id") or data.get("TaskId")
    if not task_id:
        raise RuntimeError("task_id missing in submit response")

    result = {
        "ok": False,
        "taskId": task_id,
    }

    for _ in range(poll_limit):
        time.sleep(poll_interval)
        query_resp = query_task(None, task_id, req_key)
        qdata = extract_data(query_resp)
        status = qdata.get("status")
        if status in ("done", "DONE"):
            b64 = qdata.get("binary_data_base64") or qdata.get("binary_list")
            if isinstance(b64, list) and b64:
                b64 = b64[0]
            if isinstance(b64, str):
                result["imageBase64"] = clean_b64(b64)
                out_file = os.path.join(os.getcwd(), f"jimeng_{task_id}.jpg")
                if save_image(b64, out_file):
                    result["imagePath"] = out_file
            if isinstance(qdata.get("image_urls"), list):
                result["imageUrls"] = qdata.get("image_urls")
            result["ok"] = True
            result["status"] = status
            result["raw"] = qdata
            print(json.dumps(result, ensure_ascii=False))
            return

    result["status"] = "timeout"
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    import sys
    main()

import base64
import json
import os
import re
import time
import urllib.parse
import urllib.request

from volcenginesdkcore import ApiClient, Configuration
from volcenginesdkcore.signv4 import SignerV4
from volcenginesdkcore.universal import UniversalApi, UniversalInfo


def get_env(name, default=None):
    value = os.getenv(name, default)
    if value is None or value == "":
        return default
    return value


def build_client():
    ak = get_env("VOLC_ACCESS_KEY")
    sk = get_env("VOLC_SECRET_KEY")
    if not ak or not sk:
        raise RuntimeError("VOLC_ACCESS_KEY / VOLC_SECRET_KEY 未配置")

    cfg = Configuration()
    cfg.ak = ak
    cfg.sk = sk
    cfg.region = get_env("VOLC_REGION", "cn-north-1")
    cfg.host = get_env("VOLC_HOST", "open.volcengineapi.com")
    token = get_env("VOLC_SESSION_TOKEN")
    if token:
        cfg.session_token = token

    return UniversalApi(ApiClient(cfg))


def raw_request(action, version, body_dict, method="POST"):
    ak = get_env("VOLC_ACCESS_KEY")
    sk = get_env("VOLC_SECRET_KEY")
    region = get_env("VOLC_REGION", "cn-north-1")
    host = get_env("VOLC_HOST", "open.volcengineapi.com")
    token = get_env("VOLC_SESSION_TOKEN")

    query = {"Action": action, "Version": version}
    body = json.dumps(body_dict, ensure_ascii=False)
    headers = {"Host": host, "Content-Type": "application/json; charset=utf-8"}

    SignerV4.sign("/", method, headers, body, None, query, ak, sk, region, "cv", token)
    url = "https://%s/?%s" % (host, urllib.parse.urlencode(query))
    data = body.encode("utf-8")

    req = urllib.request.Request(url, data=data, method=method)
    for k, v in headers.items():
        req.add_header(k, v)

    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw)


def submit_task(api, prompt, req_key, extra=None):
    payload = {"req_key": req_key, "prompt": prompt}
    if isinstance(extra, dict):
        payload.update(extra)
    if get_env("JIMENG_USE_RAW", "0") == "1":
        return raw_request(
            action=get_env("JIMENG_SUBMIT_ACTION", "JimengT2IV40SubmitTask"),
            version=get_env("JIMENG_SUBMIT_VERSION", "2024-06-06"),
            body_dict=payload,
            method="POST",
        )
    info = UniversalInfo(
        method="POST",
        service="cv",
        version=get_env("JIMENG_SUBMIT_VERSION", "2024-06-06"),
        action=get_env("JIMENG_SUBMIT_ACTION", "JimengT2IV40SubmitTask"),
        content_type="application/json",
    )
    return api.do_call(info, payload)


def query_task(api, task_id, req_key):
    if get_env("JIMENG_USE_RAW", "0") == "1":
        return raw_request(
            action=get_env("JIMENG_QUERY_ACTION", "CVSync2AsyncGetResult"),
            version=get_env("JIMENG_QUERY_VERSION", "2022-08-31"),
            body_dict={"req_key": req_key, "task_id": task_id},
            method="POST",
        )
    info = UniversalInfo(
        method="GET",
        service="cv",
        version=get_env("JIMENG_QUERY_VERSION", "2022-08-31"),
        action=get_env("JIMENG_QUERY_ACTION", "CVSync2AsyncGetResult"),
        content_type=None,
    )
    body = {"req_key": req_key, "task_id": task_id}
    return api.do_call(info, body)


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

    api = build_client()
    submit_resp = submit_task(api, prompt, req_key, extra)
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
        query_resp = query_task(api, task_id, req_key)
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

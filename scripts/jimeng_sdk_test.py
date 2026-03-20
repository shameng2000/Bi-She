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
from volcenginesdkcore.rest import ApiException


def get_env(name, default=None):
    value = os.getenv(name, default)
    if value is None or value == "":
        return default
    return value


def build_client():
    ak = get_env("VOLC_ACCESS_KEY")
    sk = get_env("VOLC_SECRET_KEY")
    if not ak or not sk:
        raise RuntimeError("VOLC_ACCESS_KEY / VOLC_SECRET_KEY 未设置。")

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


def submit_task(api, prompt, req_key):
    if get_env("JIMENG_USE_RAW", "1") == "1":
        return raw_request(
            action=get_env("JIMENG_SUBMIT_ACTION", "JimengT2IV40SubmitTask"),
            version=get_env("JIMENG_SUBMIT_VERSION", "2024-06-06"),
            body_dict={"req_key": req_key, "prompt": prompt},
            method="POST",
        )
    info = UniversalInfo(
        method="POST",
        service="cv",
        version=get_env("JIMENG_SUBMIT_VERSION", "2024-06-06"),
        action=get_env("JIMENG_SUBMIT_ACTION", "JimengT2IV40SubmitTask"),
        content_type="application/json",
    )
    body = {"req_key": req_key, "prompt": prompt}
    seed = get_env("JIMENG_SEED")
    if seed is not None:
        body["seed"] = int(seed)
    return api.do_call(info, body)


def query_task(api, task_id, req_key):
    if get_env("JIMENG_USE_RAW", "1") == "1":
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


def save_image_from_base64(raw_b64, out_path):
    if not raw_b64:
        return False
    if raw_b64.startswith("data:"):
        raw_b64 = raw_b64.split(",", 1)[-1]
    raw_b64 = re.sub(r"\s+", "", raw_b64)
    data = base64.b64decode(raw_b64)
    with open(out_path, "wb") as f:
        f.write(data)
    return True


def extract_data(resp):
    if not isinstance(resp, dict):
        return None
    result = resp.get("Result") or resp.get("result")
    if isinstance(result, dict):
        data = result.get("data") or result.get("Data")
        if isinstance(data, dict):
            return data
    data = resp.get("data")
    if isinstance(data, dict):
        return data
    return resp


def try_save_images(data, task_id):
    saved_any = False
    if not isinstance(data, dict):
        return saved_any
    b64_val = data.get("binary_data_base64") or data.get("binary_list")
    if isinstance(b64_val, list) and b64_val:
        out_file = os.path.join(os.getcwd(), f"jimeng_{task_id}.jpg")
        if save_image_from_base64(b64_val[0], out_file):
            print(f"已保存图片: {out_file}")
            saved_any = True
    elif isinstance(b64_val, str):
        out_file = os.path.join(os.getcwd(), f"jimeng_{task_id}.jpg")
        if save_image_from_base64(b64_val, out_file):
            print(f"已保存图片: {out_file}")
            saved_any = True

    img_urls = data.get("image_urls")
    if isinstance(img_urls, list) and img_urls:
        print(f"image_urls: {img_urls}")
    return saved_any


def main():
    prompt = get_env(
        "JIMENG_PROMPT",
        "一辆创客用途的模型小车的外壳，不要底盘，越野风格，可打印设计。",
    )
    req_key = get_env("JIMENG_REQ_KEY", "jimeng_t2i_v40")

    api = build_client()
    task_id = get_env("JIMENG_TASK_ID")
    if task_id:
        print(f"使用已有 task_id: {task_id}")
    else:
        print("Submit task...")
        submit_resp = submit_task(api, prompt, req_key)
        print(json.dumps(submit_resp, ensure_ascii=False, indent=2))

        if isinstance(submit_resp, dict):
            result = submit_resp.get("Result") or submit_resp.get("result") or {}
            data = submit_resp.get("data") if "data" in submit_resp else result.get("data")
            if isinstance(data, dict):
                task_id = data.get("task_id") or data.get("TaskId")

    if not task_id:
        print("未解析到 task_id，可从上面的输出里手动查看。")
        return

    if get_env("JIMENG_POLL", "1") != "1":
        return

    poll_interval = int(get_env("JIMENG_POLL_INTERVAL", "5"))
    print(f"TaskId: {task_id}，开始轮询...")
    for _ in range(20):
        time.sleep(poll_interval)
        try:
            query_resp = query_task(api, task_id, req_key)
            print(json.dumps(query_resp, ensure_ascii=False, indent=2))
            data = extract_data(query_resp)
            status = data.get("status") if isinstance(data, dict) else None
            try_save_images(data, task_id)
            if status in ("done", "DONE"):
                break
        except ApiException as exc:
            print(f"查询异常: {exc.status} {exc.reason}，稍后重试...")
            continue


if __name__ == "__main__":
    main()

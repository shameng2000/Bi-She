import os
import time
from volcenginesdkarkruntime import Ark

API_KEY = os.environ.get("ARK_API_KEY")
if not API_KEY:
    raise SystemExit("缺少 ARK_API_KEY 环境变量")

# 图片 URL（必须可公网直连访问；可通过环境变量覆盖）
IMAGE_URL = os.environ.get(
    "SEED3D_IMAGE_URL",
    "https://ark-project.tos-cn-beijing.volces.com/doc_image/seed3d_imageTo3d.png",
)

client = Ark(api_key=API_KEY)

print("Submit task...")
resp = client.content_generation.tasks.create(
    model="doubao-seed3d-1-0-250928",
    content=[
        {"type": "text", "text": "--subdivisionlevel medium --fileformat glb"},
        {"type": "image_url", "image_url": {"url": IMAGE_URL}},
    ],
)

task_id = None
if isinstance(resp, dict):
    task_id = resp.get("id") or resp.get("task_id")
else:
    task_id = getattr(resp, "id", None) or getattr(resp, "task_id", None)

if not task_id:
    print("响应：", resp)
    raise SystemExit("没拿到 task_id")

print("TaskId:", task_id, "开始轮询...")

for _ in range(60):
    time.sleep(5)
    status = client.content_generation.tasks.get(task_id=task_id)
    print("status:", status)
    s = ""
    if isinstance(status, dict):
        s = status.get("status", "")
    else:
        s = getattr(status, "status", "")
    if str(s).upper() in ("DONE", "COMPLETED", "SUCCESS"):
        print("完成，结果：", status)
        break

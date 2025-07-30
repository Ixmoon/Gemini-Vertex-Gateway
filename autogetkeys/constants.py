# file: autogetkeys/constants.py

# --- Process Status ---
STATUS_PENDING = "pending"
STATUS_PROCESSING = "processing"
STATUS_SUCCESS = "成功"
STATUS_FAILURE = "失败"
STATUS_LOGIN_FAILED = "登录失败"
STATUS_PARTIAL_SUCCESS = "部分成功"

# --- UI Colors ---
STATUS_COLORS = {
    STATUS_PENDING: "#808080",      # 灰色
    STATUS_PROCESSING: "#F1C40F",    # 黄色
    STATUS_SUCCESS: "#2ECC71",      # 绿色
    STATUS_FAILURE: "#E74C3C",      # 红色
    STATUS_PARTIAL_SUCCESS: "#5DADE2" # 蓝色
}

# --- Special identifiers ---
GENERAL_ERROR_ACCOUNT = "general_error"

# --- Custom Exceptions ---
class DependenciesMissingError(Exception):
    """当必要的库未安装时引发。"""
    pass

class GCloudNotInstalledError(Exception):
    """当gcloud CLI工具未找到时引发。"""
    pass
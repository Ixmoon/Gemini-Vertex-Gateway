# file: autogetkeys/retry_utils.py

import time
import logging
import threading
from functools import wraps
from google.api_core import exceptions as google_exceptions

class VerificationRequiredException(Exception):
    """当需要人工干预（如人机验证或未知2FA）时引发的特定异常。"""
    pass

def robust_retry(max_retries=3, delay=2, backoff=2, success_on_existing=False):
    """
    一个健壮的装饰器，它会重试任何异常，但会避开一个不可恢复错误的“黑名单”。
    它还会在重试等待期间检查 'stop_event'，以实现可中断的延迟。
    新增 'success_on_existing' 参数，允许在找到有效结果后，即使后续操作抛出可重试异常也视为成功。
    """
    
    UNRECOVERABLE_EXCEPTIONS = (
        VerificationRequiredException,
        google_exceptions.PermissionDenied,
        google_exceptions.NotFound,
        google_exceptions.AlreadyExists,
        google_exceptions.InvalidArgument,
        google_exceptions.FailedPrecondition,
        NotImplementedError,
        TypeError,
        InterruptedError,
    )

    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            logger = kwargs.get('logger')
            if not logger:
                for arg in args:
                    if isinstance(arg, logging.Logger):
                        logger = arg
                        break
            if not logger:
                logger = logging.getLogger(func.__name__)

            stop_event = kwargs.get('stop_event')
            if not stop_event:
                for arg in args:
                    if isinstance(arg, threading.Event):
                        stop_event = arg
                        break
            
            current_delay = delay
            # 用于存储在重试循环中可能找到的“部分”或“现有”成功结果
            existing_result = None

            for attempt in range(max_retries):
                if stop_event and stop_event.is_set():
                    logger.info(f"'{func.__name__}' 任务已跳过，无需执行。")
                    raise InterruptedError(f"'{func.__name__}' skipped as it was no longer required.")

                try:
                    # 调用原始函数，并捕获其返回值
                    result = func(*args, **kwargs)
                    # 如果函数成功执行到最后并返回，那么这就是最终结果
                    return result
                except Exception as e:
                    # 检查是否有之前保存的“现有结果”并且开启了“success_on_existing”模式
                    if success_on_existing and existing_result:
                        logger.info(f"'{func.__name__}' 找到了一个有效结果，但在后续步骤中遇到可重试错误 ({type(e).__name__})。将接受现有结果并停止重试。")
                        return existing_result

                    if isinstance(e, UNRECOVERABLE_EXCEPTIONS):
                        logger.error(f"'{func.__name__}' 遇到不可恢复错误: {type(e).__name__}。将不会重试。")
                        raise
                    
                    if attempt + 1 >= max_retries:
                        logger.error(f"'{func.__name__}' 在所有重试尝试后失败。")
                        raise

                    logger.warning(
                        f"'{func.__name__}' 失败，错误: {type(e).__name__} (尝试 {attempt + 1}/{max_retries})。 "
                        f"将在 {current_delay:.1f} 秒后重试..."
                    )
                    
                    # --- Non-blocking, interruptible wait ---
                    wait_end_time = time.time() + current_delay
                    while time.time() < wait_end_time:
                        if stop_event and stop_event.is_set():
                            logger.warning(f"重试等待被停止信号中断。")
                            raise InterruptedError("Retry wait cancelled by stop signal.")
                        time.sleep(0.1)
                    
                    current_delay *= backoff
        return wrapper
    return decorator
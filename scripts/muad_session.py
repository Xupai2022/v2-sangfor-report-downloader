#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""mssw 平台登录态：按 skill 名向 session-manager 取（自建 skill 规范）。

平台入口、Host 头、cookie 全部来自 Console 的平台设置，由 session-manager 用
`get-state --skill-name <skill>` 下发；skill 里不写死入口，也不让用户手工粘 cookie。

集群正式入口是 `node mssw_downloader.js` —— 它在 JS 侧用同一份登录态取好
cookie 与 requestProfile，再把 `--cookie-path` / `--base-url` 传给 Python 子脚本。
本模块只给「直接跑 Python 子脚本、又没传那两个参数」时兜底，两者取的都是
**同一份**登录态，不会出现 A 环境的 cookie 打 B 环境的入口。

规范出处：muad-openclaw `skills/self-skill-creator/references/session-manager.md`。
"""
import json
import os
import subprocess
import sys
import tempfile

# 必须与 muad.skill.json 的 name 逐字一致（self-skill-review 的 SS-R011 会查）
SKILL_NAME = 'v2-sangfor-report-downloader'
PLATFORM = 'mssw'
TIMEOUT_SECONDS = 60


def _fail(message):
    """fail loud：stderr 说清楚原因 + 非 0 退出，绝不静默回退到别的凭据。"""
    print(f'[session] {message}', file=sys.stderr, flush=True)
    raise SystemExit(1)


def resolve_state_file():
    """调 `session-manager get-state`，返回它下发的登录态文件路径。"""
    manager = os.environ.get('SESSION_MANAGER_BIN') or 'session-manager'
    try:
        completed = subprocess.run(
            [manager, 'get-state', '--skill-name', SKILL_NAME],
            check=False, capture_output=True, text=True, timeout=TIMEOUT_SECONDS
        )
    except FileNotFoundError:
        _fail('未找到 session-manager：集群模式需要它提供 mssw 登录态；'
              '本地调试请显式传 --cookie-path 与 --base-url')
    except subprocess.TimeoutExpired:
        _fail(f'session-manager get-state 超时（{TIMEOUT_SECONDS}s）')

    if completed.returncode != 0:
        # 只用 stderr：stdout 是登录态 JSON，拼进错误信息等于把凭据写进日志
        detail = (completed.stderr or '').strip()[:300]
        _fail(f'session-manager get-state 失败（退出码 {completed.returncode}）'
              + (f': {detail}' if detail else ''))

    try:
        state = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        _fail(f'session-manager 输出解析失败: {error}')

    state_file = state.get('sessionStateFile') if isinstance(state, dict) else None
    if not state_file or not os.path.isfile(state_file):
        _fail(f'未获取到登录态文件，请先确认 {PLATFORM} 平台已绑定并登录')
    return state_file


def read_state():
    """读登录态文件里的完整 session 对象。"""
    state_file = resolve_state_file()
    try:
        with open(state_file, 'r', encoding='utf-8') as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        _fail(f'读取登录态文件失败: {error}')


def platform_section(state, platform=PLATFORM):
    section = ((state or {}).get('platforms') or {}).get(platform)
    if not isinstance(section, dict):
        _fail(f'登录态里没有 {platform} 平台（请先在 Console 绑定并登录）')
    return section


def base_url(state, platform=PLATFORM):
    """平台入口：Console 平台设置里的 baseUrl（requestProfile.baseUrl）。"""
    profile = platform_section(state, platform).get('requestProfile') or {}
    value = profile.get('baseUrl') if isinstance(profile, dict) else None
    value = value.strip() if isinstance(value, str) else ''
    if not value:
        _fail(f'登录态里的 {platform}.requestProfile.baseUrl 为空：'
              '请在 Console 的平台设置里配好入口')
    return value


def host_header(state, platform=PLATFORM):
    """统一 Host 头；没配就返回空串（本地 SIT 不发）。"""
    profile = platform_section(state, platform).get('requestProfile') or {}
    value = profile.get('hostHeader') if isinstance(profile, dict) else None
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):
        for key, item in value.items():
            if str(key).strip().lower() == 'host' and isinstance(item, str):
                return item.strip()
    return ''


def referer_path(state, platform=PLATFORM):
    """requestProfile.referer 的路径部分；取不到返回空串。"""
    profile = platform_section(state, platform).get('requestProfile') or {}
    value = profile.get('referer') if isinstance(profile, dict) else None
    if not isinstance(value, str) or not value.strip():
        return ''
    try:
        from urllib.parse import urlparse
        return urlparse(value.strip()).path or ''
    except ValueError:
        return ''


def cookie_string(state, platform=PLATFORM):
    """把 cookies 拼成 `name=value; ...`；取不到 fail loud。"""
    cookies = platform_section(state, platform).get('cookies')
    pairs = [
        f"{item['name']}={item['value']}"
        for item in (cookies or [])
        if isinstance(item, dict) and isinstance(item.get('name'), str) and isinstance(item.get('value'), str)
    ]
    if not pairs:
        _fail(f'登录态缺少 {platform} 平台 cookie（请先确认 {platform} 平台已绑定并登录）')
    return '; '.join(pairs)


def write_cookie_file(cookie, directory=None, platform=PLATFORM):
    """把 cookie 落成私有临时文件，返回路径。

    集群 skill 根只读：默认写进 Runtime Guard 注入的 SKILL_OUTPUT_DIR，
    本地没有该变量时退回系统临时目录。
    """
    output_root = (os.environ.get('SKILL_OUTPUT_DIR') or '').strip()
    base_dir = directory or output_root or tempfile.gettempdir()
    os.makedirs(base_dir, exist_ok=True)
    handle, path = tempfile.mkstemp(prefix=f'muad_{platform}_', suffix='.cookie', dir=base_dir)
    try:
        with os.fdopen(handle, 'w', encoding='utf-8') as stream:
            stream.write(cookie)
        os.chmod(path, 0o600)
    except OSError as error:
        print(f'[session] 写 cookie 文件失败: {error}', file=sys.stderr, flush=True)
        raise SystemExit(1)
    return path

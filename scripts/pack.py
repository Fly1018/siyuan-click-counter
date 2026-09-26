#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
打包 package.zip（思源集市规范）。

仓库根目录**就是**插件源码：思源直接加载 `index.js`，不需要编译。
本脚本只负责把「进包的文件」挑出来压成一个 zip，并做几项上架硬性校验：

  · 必需文件在不在（README.md / plugin.json / index.js）
  · icon ≤ 64KB、preview ≤ 512KB，且扩展名与真实文件格式一致
  · 清单里 readme / icon / preview 声明的文件真实存在
  · zip 内路径一律用正斜杠 `/`

只进包的文件由下面的 PACKAGE_FILES / PACKAGE_DIRS 白名单决定 ——
所以 `scripts/`、`.github/`、`CHANGELOG.md`、`LICENSE`、`.gitignore`
这些仓库自身的文件不会跑进插件包里。

用法：
    python3 scripts/pack.py            # 校验并生成 ./package.zip
    python3 scripts/pack.py --check    # 只校验，不生成

更严格的规则（清单字段、命名、集市所有校验）由集市官方 PR Check 负责，
也可用发布工作区里的 bazaar-check.py 在上架前先自查一遍。
"""

import argparse
import json
import os
import struct
import sys
import zipfile

# ---- 进包白名单 ----------------------------------------------------------

PACKAGE_FILES = [
    "plugin.json",
    "index.js",
    "index.css",
    "README.md",
    "README.zh-CN.md",
]
PACKAGE_DIRS = ["i18n"]

ICON_MAX = 64 * 1024
PREVIEW_MAX = 512 * 1024

MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".avif": "image/avif",
}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "package.zip")


def fail(msg):
    print(f"  ✗ {msg}")
    sys.exit(1)


def ok(msg):
    print(f"  ✓ {msg}")


def detect_mime(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:2] == b"\xff\xd8":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[4:12] in (b"ftypavif", b"ftypavis"):
        return "image/avif"
    return ""


def image_size(data: bytes):
    """返回 (宽, 高)，取不到就返回 None。"""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        w, h = struct.unpack(">II", data[16:24])
        return w, h
    if data[:2] == b"\xff\xd8":
        i = 2
        while i < len(data) - 9:
            if data[i] != 0xFF:
                i += 1
                continue
            mark = data[i + 1]
            if mark in (0xC0, 0xC1, 0xC2, 0xC3):
                h, w = struct.unpack(">HH", data[i + 5:i + 9])
                return w, h
            if mark in (0xD8, 0xD9) or 0xD0 <= mark <= 0xD7:
                i += 2
                continue
            i += 2 + struct.unpack(">H", data[i + 2:i + 4])[0]
    return None


def rel_files(root, name):
    """列出包内相对路径（统一用 /）。"""
    p = os.path.join(root, name)
    if os.path.isfile(p):
        return [name]
    out = []
    for base, dirs, files in os.walk(p):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for f in files:
            full = os.path.join(base, f)
            out.append(os.path.relpath(full, root).replace("\\", "/"))
    return sorted(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只校验，不生成 package.zip")
    args = ap.parse_args()

    print(f"仓库根：{ROOT}")

    # ---- 读清单 ----
    manifest_path = os.path.join(ROOT, "plugin.json")
    if not os.path.isfile(manifest_path):
        fail("找不到 plugin.json")
    with open(manifest_path, encoding="utf-8") as f:
        m = json.load(f)
    version = m.get("version", "?")
    print(f"插件 {m.get('name')} v{version}")

    # ---- 必要的源码/说明文件 ----
    for fn in ("plugin.json", "index.js", "README.md"):
        if not os.path.isfile(os.path.join(ROOT, fn)):
            fail(f"包根缺少必要文件 `{fn}`")
    ok("必需文件齐全（plugin.json / index.js / README.md）")

    # ---- 清单声明的 readme / icon / preview ----
    extra = []          # 清单额外声明、需要一起进包的文件
    for key, legacy in (("icon", "icon.png"), ("preview", "preview.png")):
        declared = m.get(key)
        if declared:
            path = os.path.join(ROOT, declared)
            if not os.path.isfile(path):
                fail(f"清单 `{key}` 声明了 `{declared}`，但文件不存在")
            extra.append(declared)
        elif os.path.isfile(os.path.join(ROOT, legacy)):
            extra.append(legacy)
        elif key == "preview":
            print("  · 未提供 preview 图（集市允许，只是列表里没有配图）")

    for locale, path in (m.get("readme") or {}).items():
        if not os.path.isfile(os.path.join(ROOT, path)):
            fail(f"清单 `readme.{locale}` 声明了 `{path}`，但文件不存在")

    # ---- 图片体积与真实格式 ----
    for key, legacy, limit in (("icon", "icon.png", ICON_MAX),
                               ("preview", "preview.png", PREVIEW_MAX)):
        fn = m.get(key) or (legacy if os.path.isfile(os.path.join(ROOT, legacy)) else None)
        if not fn:
            continue
        with open(os.path.join(ROOT, fn), "rb") as f:
            data = f.read()
        ext = os.path.splitext(fn)[1].lower()
        want = MIME_BY_EXT.get(ext)
        if not want:
            fail(f"`{fn}` 扩展名不受支持（集市只收 PNG/JPEG/WebP/AVIF，不收 SVG）")
        if len(data) > limit:
            fail(f"`{fn}` 体积 {len(data) / 1024:.1f}KB 超过上限 {limit / 1024:.0f}KB")
        got = detect_mime(data)
        if got != want:
            fail(f"`{fn}` 扩展名是 {want}，内容实际是 {got or '未知格式'}")
        dim = image_size(data) or ("?", "?")
        ok(f"{key}: {fn} {dim[0]}x{dim[1]} {len(data) / 1024:.1f}KB ≤ "
           f"{limit / 1024:.0f}KB")

    # ---- 收集进包文件 ----
    entries = []
    for name in sorted(set(PACKAGE_FILES + PACKAGE_DIRS + extra)):
        found = rel_files(ROOT, name)
        if not found and name not in PACKAGE_DIRS:
            fail(f"白名单里的 `{name}` 不存在")
        entries.extend(found)

    # 必需文件必须在
    for need in ("plugin.json", "index.js", "README.md"):
        if need not in entries:
            fail(f"`{need}` 没有被收进包里")
    entries = sorted(set(entries))
    print(f"\n  进包 {len(entries)} 个文件：")
    for e in entries:
        print(f"    {e}")

    if args.check:
        print("\n校验通过（--check，未生成 zip）")
        return 0

    # ---- 写 zip（路径一律 / ） ----
    if os.path.exists(OUT):
        os.remove(OUT)
    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for e in entries:
            z.write(os.path.join(ROOT, e), e)
    size = os.path.getsize(OUT)
    ok(f"已生成 {OUT}（{size / 1024:.1f} KB）")
    print("\n下一步：把这个 package.zip 作为 Release 附件上传，"
          "文件名保持 `package.zip`（打 tag 时由 GitHub Actions 自动完成）。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

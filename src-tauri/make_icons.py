"""生成 ClickFlow 应用图标：圆角深色底板 + 渐变点击波纹。纯标准库绘制。"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), "icons")
os.makedirs(OUT, exist_ok=True)


def clamp(v, lo=0.0, hi=1.0):
    return max(lo, min(hi, v))


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c1, c2, t):
    return tuple(lerp(c1[i], c2[i], t) for i in range(3))


def rounded_rect_sdf(x, y, size, radius):
    h = size / 2.0
    qx = abs(x - h) - (h - radius)
    qy = abs(y - h) - (h - radius)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return outside + inside - radius


def render(size):
    rows = []
    pad = size * 0.055          # 图标四周留白
    board = size - pad * 2      # 底板边长
    radius = board * 0.235
    center = size / 2.0
    dot_r = size * 0.088
    ring_r = size * 0.215
    ring_w = max(1.0, size * 0.028)
    outer_r = size * 0.325
    outer_w = max(1.0, size * 0.014)

    for y in range(size):
        row = bytearray()
        for x in range(size):
            px, py = x + 0.5, y + 0.5

            # --- 底板 ---
            sdf = rounded_rect_sdf(px - pad, py - pad, board, radius)
            board_a = clamp(0.5 - sdf)

            if board_a <= 0:
                row.extend((0, 0, 0, 0))
                continue

            # 底板渐变：左上靛蓝 → 右下深黑
            t = clamp(((px - pad) + (py - pad)) / (board * 2))
            base = mix((26, 30, 44), (10, 12, 18), t)
            # 顶部高光
            hl = clamp(1.0 - (py - pad) / (board * 0.55)) ** 2 * 0.30
            base = mix(base, (99, 102, 241), hl * 0.55)

            # --- 波纹圆环 ---
            dist = math.hypot(px - center, py - center)
            ring_a = clamp(0.5 + ring_w / 2 - abs(dist - ring_r))
            ring_c = mix((129, 140, 248), (34, 211, 238), clamp(dist / outer_r))

            # 外圈细环
            outer_a = clamp(0.5 + outer_w / 2 - abs(dist - outer_r)) * 0.55

            # --- 中心实心圆 ---
            core_a = clamp(dot_r - dist + 0.5)
            core_c = mix((129, 140, 248), (34, 211, 238), clamp(dist / max(dot_r, 1e-6)))

            # 中心白色高光点
            glow_a = clamp(dot_r * 0.34 - dist + 0.5)

            color = base
            color = mix(color, ring_c, ring_a * 0.95)
            color = mix(color, (34, 211, 238), outer_a)
            color = mix(color, core_c, core_a)
            color = mix(color, (255, 255, 255), glow_a * 0.85)

            row.extend(
                (
                    int(clamp(color[0], 0, 255)),
                    int(clamp(color[1], 0, 255)),
                    int(clamp(color[2], 0, 255)),
                    int(clamp(board_a, 0, 1) * 255),
                )
            )
        rows.append(bytes(row))
    return rows


def write_png(path, size):
    rows = render(size)
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)
    return png


def write_ico(path, png_bytes, size):
    # ICO 直接内嵌 PNG（Windows Vista+ 支持）
    header = struct.pack("<HHH", 0, 1, 1)
    dim = 0 if size >= 256 else size
    entry = struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png_bytes), 22)
    with open(path, "wb") as fh:
        fh.write(header + entry + png_bytes)


targets = {
    "32x32.png": 32,
    "128x128.png": 128,
    "128x128@2x.png": 256,
    "icon.png": 512,
    "Square150x150Logo.png": 150,
    "Square44x44Logo.png": 44,
    "StoreLogo.png": 50,
}

for name, px in targets.items():
    write_png(os.path.join(OUT, name), px)

ico_png = write_png(os.path.join(OUT, "icon-256.png"), 256)
write_ico(os.path.join(OUT, "icon.ico"), ico_png, 256)
os.remove(os.path.join(OUT, "icon-256.png"))

print("icons written:", sorted(os.listdir(OUT)))

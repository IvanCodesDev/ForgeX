import argparse
from pathlib import Path

from PIL import Image


parser = argparse.ArgumentParser()
parser.add_argument(
    "folder",
    nargs="?",
    default=str(Path(__file__).resolve().parents[1] / "doc" / "_render_optimization_manual"),
)
args = parser.parse_args()

folder = Path(args.folder).resolve()
pages = sorted(folder.glob("page-*.png"))
output = folder / "contact"
output.mkdir(exist_ok=True)

thumb = (595, 842)
margin = 24
background = (222, 229, 235)

for start in range(0, len(pages), 4):
    batch = pages[start : start + 4]
    canvas = Image.new(
        "RGB",
        (thumb[0] * 2 + margin * 3, thumb[1] * 2 + margin * 3),
        background,
    )
    for index, page in enumerate(batch):
        image = Image.open(page).convert("RGB")
        image.thumbnail(thumb)
        x = margin + (index % 2) * (thumb[0] + margin)
        y = margin + (index // 2) * (thumb[1] + margin)
        canvas.paste(image, (x, y))
    canvas.save(output / f"contact-{start + 1:02d}-{start + len(batch):02d}.png")

print(f"created={len(list(output.glob('*.png')))}")

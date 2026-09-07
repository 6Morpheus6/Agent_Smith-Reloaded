from PIL import Image, ImageDraw

def create_icon(path):
    img = Image.new('RGB', (256, 256), color = (73, 109, 137))
    d = ImageDraw.Draw(img)
    d.text((10,10), "XC", fill=(255,255,0))
    img.save(path)

if __name__ == "__main__":
    create_icon("icon.png")

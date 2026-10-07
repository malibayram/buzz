import math
O = "#4b22a8"; SW = 30
# body: teardrop = head circle + stinger tip (Magibu drop turned sideways)
H = (620, 540); R = 210; T = (175, 540)
d = math.dist(H, T); a = math.acos(R / d)
p1 = (H[0] + R*math.cos(math.pi - a), H[1] - R*math.sin(math.pi - a))
p2 = (H[0] + R*math.cos(math.pi + a), H[1] - R*math.sin(math.pi + a))
f = lambda p: f"{p[0]:.1f} {p[1]:.1f}"
body = "M200 560 C262 452 430 300 610 300 A220 220 0 0 1 610 740 C430 740 262 660 200 560 Z"
def cloud(x, y, s):
    # Magibu cloud: three bumps on a rounded base, origin = bottom-centre
    c = lambda cx, cy, r: f'<circle cx="{x+cx*s:.1f}" cy="{y+cy*s:.1f}" r="{r*s:.1f}"/>'
    return (c(-62, -70, 52) + c(0, -102, 72) + c(64, -66, 50) +
            f'<rect x="{x-112*s:.1f}" y="{y-80*s:.1f}" width="{224*s:.1f}" height="{80*s:.1f}" rx="{40*s:.1f}"/>')
def drop(x, y, k=1):
    return (f"M{x} {y-34*k} C{x+8*k} {y-20*k} {x+24*k} {y-2*k} {x+24*k} {y+14*k} "
            f"A{24*k} {24*k} 0 0 1 {x-24*k} {y+14*k} C{x-24*k} {y-2*k} {x-8*k} {y-20*k} {x} {y-34*k} Z")
def spark(cx, cy, r):
    return f"M{cx} {cy-r} Q{cx} {cy} {cx+r} {cy} Q{cx} {cy} {cx} {cy+r} Q{cx} {cy} {cx-r} {cy} Q{cx} {cy} {cx} {cy-r} Z"
wingB = cloud(0, 0, .8); wingF = cloud(0, 0, .98)
defs = f'''<linearGradient id="g" x1="180" y1="700" x2="820" y2="360" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#6d4dff"/><stop offset=".5" stop-color="#bb52e8"/><stop offset="1" stop-color="#ff7b8f"/></linearGradient>
  <linearGradient id="w" x1="0" y1="-180" x2="0" y2="0" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e3d9ff"/></linearGradient>
  <linearGradient id="orb" x1="90" y1="0" x2="940" y2="0" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#6d4dff" stop-opacity=".15"/><stop offset=".5" stop-color="#8f5cff"/><stop offset="1" stop-color="#ff7b8f"/></linearGradient>
  <radialGradient id="bub" cx=".35" cy=".35" r=".7"><stop offset="0" stop-color="#ffd3da"/><stop offset="1" stop-color="#ff6f8a"/></radialGradient>'''
orbit = "M150 700 C260 830 780 800 906 600"   # front half of the flight loop
orbit_back = "M906 600 C990 470 720 380 440 420"
mark = f'''<g stroke-linejoin="round" stroke-linecap="round">
  <path d="{orbit_back}" fill="none" stroke="url(#orb)" stroke-width="16" opacity=".55"/>
  <g transform="translate(432 300) rotate(-28)"><g fill="{O}" stroke="{O}" stroke-width="{SW*2}">{wingB}</g><g fill="url(#w)" opacity=".85">{wingB}</g></g>
  <g transform="translate(566 258) rotate(-8)"><g fill="{O}" stroke="{O}" stroke-width="{SW*2}">{wingF}</g><g fill="url(#w)">{wingF}</g></g>
  <path d="{body}" fill="{O}" stroke="{O}" stroke-width="{SW*2}"/>
  <path d="{body}" fill="url(#g)"/>
  <clipPath id="bc"><path d="{body}"/></clipPath>
  <g clip-path="url(#bc)" fill="none" stroke="{O}" stroke-width="58">
    <path d="M462 250 Q418 520 462 790"/><path d="M332 250 Q300 540 332 790"/>
  </g>
  <path d="M626 348 Q730 344 786 420" fill="none" stroke="#fff" stroke-width="22" opacity=".45"/>
  <g fill="{O}"><circle cx="658" cy="500" r="40"/><circle cx="760" cy="500" r="40"/></g>
  <g fill="#fff"><circle cx="670" cy="486" r="12"/><circle cx="772" cy="486" r="12"/></g>
  <path d="{drop(168, 664, 1.1)}" fill="#c9b6f7" stroke="{O}" stroke-width="16"/>
  <path d="{orbit}" fill="none" stroke="url(#orb)" stroke-width="18"/>
  <circle cx="906" cy="600" r="34" fill="url(#bub)" stroke="{O}" stroke-width="14"/>
  <circle cx="896" cy="589" r="9" fill="#fff" opacity=".8"/>
  <path d="{spark(842, 236, 52)}" fill="#ffc94d" stroke="#ffc94d" stroke-width="6"/>
  <path d="{spark(930, 330, 24)}" fill="#ffc94d"/>
</g>'''
def svg(vb, body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="MagiBuzz">\n<defs>{defs}</defs>\n{body}\n</svg>\n'

POSE = "rotate(-10) translate(-530 -470)"   # centres the bee+orbit around the origin
open("magibuzz-mark.svg","w").write(svg("-400 -400 800 800", f'<g transform="{POSE}">{mark}</g>'))
open("magibuzz-app-icon.svg","w").write(svg("0 0 1024 1024",
  f'<rect width="1024" height="1024" fill="#faf7ff"/><g transform="translate(512 512) scale(.92) {POSE}">{mark}</g>'))
open("magibuzz-app-icon-dark.svg","w").write(svg("0 0 1024 1024",
  f'''<radialGradient id="glow" cx="512" cy="470" r="560" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3a1f7a"/><stop offset="1" stop-color="#0d0820"/></radialGradient>
  <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="70"/></filter>
  <rect width="1024" height="1024" fill="url(#glow)"/><ellipse cx="520" cy="540" rx="330" ry="250" fill="#9b6bff" opacity=".45" filter="url(#blur)"/><g transform="translate(512 512) scale(.92) {POSE}">{mark}</g>'''))
font = 'font-family="SF Pro Rounded, ui-rounded, Nunito, system-ui, sans-serif" font-weight="800"'
open("magibuzz-lockup.svg","w").write(svg("0 0 1640 520",
  f'''<linearGradient id="gt" x1="1000" y1="0" x2="1560" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7a5cff"/><stop offset="1" stop-color="#ff7b8f"/></linearGradient>
  <rect width="1640" height="520" fill="#ffffff"/>
  <g transform="translate(270 262) scale(.5) {POSE}">{mark}</g>
  <text x="540" y="320" {font} font-size="196" letter-spacing="-5"><tspan fill="#2a1060">Magi</tspan><tspan fill="url(#gt)">Buzz</tspan></text>'''))

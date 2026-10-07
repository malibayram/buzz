# MagiBuzz = Buzz bee silhouette as the Magibu cloud, over the Magibu trunk + petri dish.
O = "#5b2fc0"   # outline (Magibu purple)
SW = 34
def drop(x, y):
    return (f"M{x} {y-34} C{x+8} {y-20} {x+24} {y-2} {x+24} {y+14} "
            f"A24 24 0 0 1 {x-24} {y+14} C{x-24} {y-2} {x-8} {y-20} {x} {y-34} Z")
bee = ('<circle cx="300" cy="382" r="137"/><circle cx="724" cy="382" r="137"/>'
       '<rect x="355" y="150" width="314" height="463" rx="52"/>')
defs = f'''<linearGradient id="g" x1="160" y1="0" x2="864" y2="0" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#7a5cff"/><stop offset=".55" stop-color="#c25ae6"/><stop offset="1" stop-color="#ff7b8f"/></linearGradient>
  <linearGradient id="liq" x1="0" y1="780" x2="0" y2="930" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#cdbcf5"/><stop offset="1" stop-color="#b39bec"/></linearGradient>'''
mark = f'''<g stroke-linejoin="round" stroke-linecap="round">
  <ellipse cx="512" cy="742" rx="306" ry="48" fill="#ece7f6" stroke="{O}" stroke-width="{SW}"/>
  <path d="M418 590 C470 650 474 730 424 920 L600 920 C550 730 554 650 606 590 Z" fill="#f6f3fb" stroke="{O}" stroke-width="{SW}"/>
  <path d="M478 640 C500 700 498 760 476 830" fill="none" stroke="#ffffff" stroke-width="22"/>
  <path d="M206 840 C330 812 420 872 512 852 S706 820 818 838 L818 904 A306 48 0 0 1 206 904 Z" fill="url(#liq)"/>
  <path d="M206 840 C330 812 420 872 512 852 S706 820 818 838" fill="none" stroke="{O}" stroke-width="22"/>
  <circle cx="604" cy="902" r="16" fill="{O}" opacity=".45"/><circle cx="656" cy="878" r="9" fill="{O}" opacity=".45"/>
  <path d="M206 742 L206 904 A306 48 0 0 0 818 904 L818 742 A306 48 0 0 1 206 742" fill="none" stroke="{O}" stroke-width="{SW}"/>
  <g fill="{O}" stroke="{O}" stroke-width="{SW*2}">{bee}</g>
  <g fill="url(#g)">{bee}</g>
  <path d="M398 214 Q404 192 430 190 L470 190" fill="none" stroke="#ffffff" stroke-width="20" opacity=".45"/>
  <g fill="{O}">
    <circle cx="452" cy="277" r="41"/><circle cx="576" cy="277" r="41"/>
    <rect x="411" y="386" width="205" height="57" rx="9"/><rect x="412" y="503" width="204" height="56" rx="9"/>
  </g>
  <path d="{drop(290, 612)}" fill="#c9b6f7" stroke="{O}" stroke-width="18"/>
  <path d="{drop(734, 612)}" fill="#ffb0bd" stroke="{O}" stroke-width="18"/>
</g>'''
def svg(vb, body, label="MagiBuzz"):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="{label}">\n<defs>{defs}</defs>\n{body}\n</svg>\n'
# transparent mark
open("magibuzz-mark.svg", "w").write(svg("110 80 804 870", mark))
# app icon: light rounded tile
open("magibuzz-app-icon.svg", "w").write(svg("0 0 1024 1024",
    f'<rect width="1024" height="1024" fill="#faf7ff"/><g transform="translate(512 520) scale(.86) translate(-512 -532)">{mark}</g>'))
# app icon dark (Magibu night look)
open("magibuzz-app-icon-dark.svg", "w").write(svg("0 0 1024 1024",
    f'''<radialGradient id="glow" cx="512" cy="470" r="520" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3a1f7a"/><stop offset="1" stop-color="#0d0820"/></radialGradient>
    <rect width="1024" height="1024" fill="url(#glow)"/><g transform="translate(512 520) scale(.86) translate(-512 -532)">{mark}</g>'''))
# horizontal lockup
font = 'font-family="SF Pro Rounded, ui-rounded, Nunito, system-ui, sans-serif" font-weight="800"'
open("magibuzz-lockup.svg", "w").write(svg("0 0 1600 520",
    f'''<rect width="1600" height="520" fill="#ffffff"/>
    <g transform="translate(250 260) scale(.48) translate(-512 -515)">{mark}</g>
    <text x="500" y="318" {font} font-size="190" letter-spacing="-5"><tspan fill="#2a1060">Magi</tspan><tspan fill="url(#gt)">Buzz</tspan></text>
    <linearGradient id="gt" x1="960" y1="0" x2="1500" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#7a5cff"/><stop offset="1" stop-color="#ff7b8f"/></linearGradient>'''))

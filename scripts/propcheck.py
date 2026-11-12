"""
Catch the specific bug that blacked out the app: a prop declared in a Props
interface and USED in the component body, but never destructured from props.

TypeScript with noUnusedLocals off does flag this as TS2304, but only when the
whole project typechecks. This is a cheap targeted check that works standalone.
"""
import re, sys, pathlib

bad = []
for f in pathlib.Path('src').rglob('*.tsx'):
    src = f.read_text()
    m = re.search(r'interface Props \{(.*?)\n\}', src, re.S)
    if not m:
        continue
    props = set(re.findall(r'^\s*(\w+)\??\s*:', m.group(1), re.M))

    d = re.search(r'export default function \w+\(\{(.*?)\}\s*:\s*Props\)', src, re.S)
    if not d:
        continue
    destructured = set(re.findall(r'(\w+)\s*(?:=|,|$)', d.group(1)))

    body = src[d.end():]
    for p in props - destructured:
        # used as a bare identifier in the body?
        if re.search(rf'(?<![.\w]){re.escape(p)}(?![\w:])', body):
            bad.append(f"{f}: prop '{p}' is used but never destructured")

if bad:
    print("✗ Props used without being destructured (this crashes at render):")
    for b in bad:
        print("   " + b)
    sys.exit(1)
print("✓ all used props are destructured")

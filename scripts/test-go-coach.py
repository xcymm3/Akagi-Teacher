"""Run the full Go suite, distinguishing reproduced upstream ranking failures."""
import json, os, subprocess, sys
from pathlib import Path
root = Path(__file__).resolve().parents[1]
p = subprocess.run([os.environ.get("GO", "go"), "test", "-json", "./util/...", "./cmd/coach"], cwd=root / "coach-go", capture_output=True, text=True, encoding="utf-8")
failed, failed_packages, passed = set(), set(), 0
for line in p.stdout.splitlines():
    try:
        event = json.loads(line)
    except ValueError:
        continue
    if not event.get("Test") and event.get("Action") == "fail":
        failed_packages.add(event.get("Package", "unknown"))
    if event.get("Test") and event.get("Action") == "fail":
        failed.add(event["Test"])
    if event.get("Test") and event.get("Action") == "pass":
        passed += 1
known = {"TestBest2", "TestQ300"}
print(json.dumps({"passed": passed, "failed": sorted(failed), "known_upstream_failures": sorted(known), "unexpected_failures": sorted(failed - known)}, ensure_ascii=False))
if failed - known or failed_packages - {"github.com/EndlessCheng/mahjong-helper/util"} or (p.returncode and not failed):
    print(p.stdout)
    print(p.stderr, file=sys.stderr)
    sys.exit(1)
if failed:
    print("WARNING: original upstream ranking expectations still fail; see coach-go/UPSTREAM.md")

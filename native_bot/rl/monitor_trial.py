"""Read-only per-process telemetry, useful when a training GPU is shared."""
import argparse
import datetime
import json
from pathlib import Path
import subprocess
import time

import psutil


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--gpu", type=int, default=1)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--interval", type=float, default=5)
    args = parser.parse_args()
    process = psutil.Process(args.pid)
    identity = process.create_time()
    known = {}
    with args.out.open("x") as stream:
        while process.is_running() and process.status() != psutil.STATUS_ZOMBIE:
            if process.create_time() != identity:
                break
            tick = time.monotonic()
            try:
                members = [process] + process.children(recursive=True)
                cpu = rss = 0.
                live = set()
                for member in members:
                    try:
                        live.add(member.pid)
                        if member.pid not in known:
                            known[member.pid] = member
                            member.cpu_percent()
                        else:
                            cpu += known[member.pid].cpu_percent()
                        rss += member.memory_info().rss
                    except psutil.NoSuchProcess:
                        pass
                known = {pid: p for pid, p in known.items() if pid in live}
                output = subprocess.check_output(["nvidia-smi", "pmon", "-i", str(args.gpu),
                                                  "-s", "um", "-c", "1"], text=True, timeout=10)
                header, rows = None, []
                for line in output.splitlines():
                    if line.startswith("# gpu"):
                        header = line[1:].split()
                    elif line.strip() and not line.startswith("#") and header:
                        rows.append(dict(zip(header, line.split())))
                record = {"utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                          "t": time.perf_counter(), "pid": args.pid,
                          "tree_cpu_pct_one_core": cpu,
                          "tree_cpu_pct_host": cpu / psutil.cpu_count(),
                          "tree_rss_sum_bytes": rss, "members": len(live), "gpu_processes": rows}
                stream.write(json.dumps(record)+"\n"); stream.flush()
            except psutil.NoSuchProcess:
                break
            time.sleep(max(0., args.interval-(time.monotonic()-tick)))


if __name__ == "__main__":
    main()

"""Time series at four resolutions.

The panel offers 90s / 15m / 1h / 24h windows, and keeping 24h of one-second
samples would be 86,400 points per reading for a chart 1000px wide. So each
reading keeps four ring buffers and every sample is folded into all of them:
the coarse tiers average what falls inside their bucket rather than sampling
one point out of it, because a spike that lasts four seconds should still be
visible in the hour view.
"""

WINDOWS = (
    ("90s", 1.0, 90),        # label, seconds per bucket, buckets kept
    ("15m", 10.0, 90),
    ("1h", 40.0, 90),
    ("24h", 960.0, 90),
)


class Series:
    """One reading, retained at every window."""

    def __init__(self):
        self._tiers = []
        for label, span, size in WINDOWS:
            self._tiers.append({
                "label": label, "span": span, "size": size,
                "points": [], "bucket": None, "sum": 0.0, "count": 0,
            })

    def add(self, value, now):
        for tier in self._tiers:
            index = int(now // tier["span"])
            if tier["bucket"] is None:
                tier["bucket"] = index
            if index != tier["bucket"]:
                closed = tier["sum"] / tier["count"] if tier["count"] else None
                tier["points"].append(closed)
                # A sampler that ticks every second against one-second buckets
                # will occasionally miss one to jitter alone. Carrying the last
                # value across a short skip keeps that from drawing as a hole
                # in the line; a real outage is longer than this and still
                # reads as a gap.
                skipped = min(index - tier["bucket"] - 1, tier["size"])
                carry = closed if skipped <= 2 else None
                for _ in range(skipped):
                    tier["points"].append(carry)
                tier["bucket"], tier["sum"], tier["count"] = index, 0.0, 0
                if len(tier["points"]) > tier["size"]:
                    del tier["points"][:len(tier["points"]) - tier["size"]]
            if value is not None:
                tier["sum"] += float(value)
                tier["count"] += 1

    def window(self, label):
        for tier in self._tiers:
            if tier["label"] == label:
                live = tier["sum"] / tier["count"] if tier["count"] else None
                return tier["points"] + [live]
        return []

    def all_windows(self):
        return {t["label"]: self.window(t["label"]) for t in self._tiers}


class Readings:
    """A named set of series, so callers do not carry dictionaries around."""

    def __init__(self):
        self._series = {}

    def add(self, name, value, now):
        self._series.setdefault(name, Series()).add(value, now)

    def payload(self):
        return {name: s.all_windows() for name, s in self._series.items()}

    def drop(self, keep):
        for name in [n for n in self._series if n not in keep]:
            del self._series[name]

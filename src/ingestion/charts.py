#!/usr/bin/env python3
"""Generate descriptive statistics charts from the pginbox database."""

import os
import sys

import psycopg2
import pandas as pd
from dotenv import load_dotenv

load_dotenv()
import matplotlib.pyplot as plt
import matplotlib.ticker as ticker
import numpy as np

DSN = os.environ.get("DATABASE_URL", "postgresql://pginbox:pginbox@localhost:5499/pginbox")
OUT = "charts/charts.png"

conn = psycopg2.connect(DSN)

msgs_by_month = pd.read_sql("""
    SELECT
        EXTRACT(year  FROM sent_at)::int AS year,
        EXTRACT(month FROM sent_at)::int AS month,
        count(*) AS messages
    FROM messages
    WHERE sent_at IS NOT NULL
    GROUP BY 1, 2 ORDER BY 1, 2
""", conn)

thread_sizes = pd.read_sql("SELECT message_count FROM threads", conn)

top_senders = pd.read_sql("""
    SELECT
        from_email,
        count(*) AS messages,
        mode() WITHIN GROUP (ORDER BY from_name) AS from_name
    FROM messages WHERE from_email != '' AND from_name != ''
    GROUP BY from_email ORDER BY messages DESC LIMIT 15
""", conn)

by_hour = pd.read_sql("""
    SELECT EXTRACT(hour FROM sent_at AT TIME ZONE 'UTC')::int AS hour, count(*) AS messages
    FROM messages WHERE sent_at IS NOT NULL AND NOT sent_at_approx
    GROUP BY 1 ORDER BY 1
""", conn)

by_dow = pd.read_sql("""
    SELECT EXTRACT(isodow FROM sent_at)::int AS dow, count(*) AS messages
    FROM messages WHERE sent_at IS NOT NULL AND NOT sent_at_approx
    GROUP BY 1 ORDER BY 1
""", conn)

body_lengths = pd.read_sql("""
    SELECT length(body) AS body_len FROM messages
    WHERE body IS NOT NULL AND length(body) BETWEEN 1 AND 50000
""", conn)

unique_senders  = pd.read_sql("SELECT count(DISTINCT from_email) AS n FROM messages WHERE from_email != ''", conn).iloc[0]["n"]
total_messages  = pd.read_sql("SELECT count(*) AS n FROM messages", conn).iloc[0]["n"]
total_threads   = pd.read_sql("SELECT count(*) AS n FROM threads", conn).iloc[0]["n"]
months_ingested = pd.read_sql("""
    SELECT count(DISTINCT date_trunc('month', sent_at)) AS n
    FROM messages WHERE sent_at IS NOT NULL
""", conn).iloc[0]["n"]

conn.close()

# ---------------------------------------------------------------------------
# Plot
# ---------------------------------------------------------------------------

fig = plt.figure(figsize=(18, 14))
fig.suptitle("pgsql-hackers Archive — Descriptive Statistics", fontsize=16, fontweight="bold", y=0.98)

# 1. Messages per month — year/month heatmap
ax1 = fig.add_subplot(3, 3, 1)
all_years  = sorted(msgs_by_month["year"].unique())
all_months = list(range(1, 13))
heatmap = (
    msgs_by_month
    .pivot(index="year", columns="month", values="messages")
    .reindex(index=all_years, columns=all_months)
    .fillna(0)
)
im = ax1.imshow(heatmap.values, aspect="auto", cmap="Blues", interpolation="none")
ax1.set_xticks(range(12))
ax1.set_xticklabels(["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],
                    fontsize=7, rotation=45, ha="right")
ax1.set_yticks(range(len(all_years)))
ax1.set_yticklabels(all_years, fontsize=6)
ax1.set_title("Messages per Month")
for r, year in enumerate(all_years):
    for c, mon in enumerate(all_months):
        val = int(heatmap.iloc[r, c])
        if val > 0:
            text_color = "white" if val > heatmap.values.max() * 0.6 else "black"
            ax1.text(c, r, f"{val:,}", ha="center", va="center",
                     fontsize=4, color=text_color)

# 2. Thread size distribution
ax2 = fig.add_subplot(3, 3, 2)
bins = [1, 2, 3, 5, 10, 20, 50, 100, 250]
counts, edges = np.histogram(thread_sizes["message_count"], bins=bins)
ax2.bar(range(len(counts)), counts, color="#336791",
        tick_label=[f"{edges[i]}–{edges[i+1]-1}" for i in range(len(counts))])
ax2.set_title("Thread Size Distribution")
ax2.set_xlabel("Messages per Thread")
ax2.set_ylabel("Threads")
ax2.tick_params(axis='x', rotation=30, labelsize=8)

# 3. Top 15 senders
ax3 = fig.add_subplot(3, 3, 3)
labels = list(top_senders["from_name"])
ax3.barh(range(len(labels)), top_senders["messages"], color="#336791")
ax3.set_yticks(range(len(labels)))
ax3.set_yticklabels(labels, fontsize=8)
ax3.invert_yaxis()
ax3.set_title("Top 15 Senders")
ax3.set_xlabel("Messages")

# 4. Messages by hour of day
ax4 = fig.add_subplot(3, 3, 4)
all_hours = pd.DataFrame({"hour": range(24)})
by_hour_full = all_hours.merge(by_hour, on="hour", how="left").fillna(0)
ax4.bar(by_hour_full["hour"], by_hour_full["messages"], color="#336791")
ax4.set_title("Messages by Hour of Day (UTC)")
ax4.set_xlabel("Hour")
ax4.set_ylabel("Messages")
ax4.set_xticks(range(0, 24, 2))

# 5. Messages by day of week
ax5 = fig.add_subplot(3, 3, 5)
dow_labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
all_dows = pd.DataFrame({"dow": range(1, 8)})
by_dow_full = all_dows.merge(by_dow, on="dow", how="left").fillna(0)
colors = ["#336791"] * 5 + ["#a0c4d8"] * 2
ax5.bar(dow_labels, by_dow_full["messages"], color=colors)
ax5.set_title("Messages by Day of Week")
ax5.set_ylabel("Messages")

# 6. Body length distribution
ax6 = fig.add_subplot(3, 3, 6)
ax6.hist(body_lengths["body_len"], bins=60, color="#336791", edgecolor="none")
ax6.set_title("Message Body Length Distribution")
ax6.set_xlabel("Characters")
ax6.set_ylabel("Messages")
ax6.xaxis.set_major_formatter(ticker.FuncFormatter(lambda x, _: f"{int(x/1000)}k"))

# 7. Thread size CDF
ax7 = fig.add_subplot(3, 3, 7)
sorted_sizes = np.sort(thread_sizes["message_count"])
cdf = np.arange(1, len(sorted_sizes) + 1) / len(sorted_sizes)
ax7.plot(sorted_sizes, cdf, color="#336791", linewidth=2)
ax7.set_xscale("log")
ax7.set_title("Thread Size CDF")
ax7.set_xlabel("Messages per Thread (log scale)")
ax7.set_ylabel("Cumulative Fraction")
ax7.axhline(0.5, color="gray", linestyle="--", linewidth=0.8, label="median")
ax7.axhline(0.9, color="gray", linestyle=":", linewidth=0.8, label="90th pct")
ax7.legend(fontsize=8)
ax7.grid(True, alpha=0.3)

# 8. Thread size box plot
ax8 = fig.add_subplot(3, 3, 8)
ax8.boxplot(thread_sizes["message_count"], vert=True, patch_artist=True,
            boxprops=dict(facecolor="#336791", alpha=0.7),
            medianprops=dict(color="white", linewidth=2),
            flierprops=dict(marker=".", markersize=3, alpha=0.3))
ax8.set_title("Thread Size Box Plot")
ax8.set_ylabel("Messages per Thread")
ax8.set_yscale("log")
p95 = int(thread_sizes["message_count"].quantile(0.95))
stats = thread_sizes["message_count"].describe()
info = f"mean={stats['mean']:.1f}\nmedian={int(stats['50%'])}\np95={p95}\nmax={int(stats['max'])}"
ax8.text(1.3, stats["75%"], info, fontsize=8, va="center")
ax8.set_xticks([])

# 9. Summary table
ax9 = fig.add_subplot(3, 3, 9)
ax9.axis("off")
rows = [
    ["Total messages",     f"{int(total_messages):,}"],
    ["Total threads",      f"{int(total_threads):,}"],
    ["Months ingested",    f"{int(months_ingested)}"],
    ["Avg msg / thread",   f"{total_messages/total_threads:.1f}"],
    ["Median thread size", f"{int(thread_sizes['message_count'].median())}"],
    ["Single-msg threads", f"{int((thread_sizes['message_count']==1).sum()):,}"],
    ["Threads > 50 msgs",  f"{int((thread_sizes['message_count']>50).sum()):,}"],
    ["Unique senders",     f"{int(unique_senders):,}"],
]
table = ax9.table(cellText=rows, colLabels=["Metric", "Value"],
                  cellLoc="left", loc="center", colWidths=[0.65, 0.35])
table.auto_set_font_size(False)
table.set_fontsize(9)
table.scale(1, 1.6)
for (r, c), cell in table.get_celld().items():
    if r == 0:
        cell.set_facecolor("#336791")
        cell.set_text_props(color="white", fontweight="bold")
    elif r % 2 == 0:
        cell.set_facecolor("#f0f4f8")
    cell.set_edgecolor("none")
ax9.set_title("Summary", pad=12)

plt.tight_layout(rect=[0, 0, 1, 0.97])
plt.savefig(OUT, dpi=150, bbox_inches="tight")
print(f"Saved {OUT}")

"""Evaluate Autopay Shield's machine learning on the labelled benchmark.

Run from the repo root:
    npm --prefix api run benchmark     # builds ml/data/benchmark.csv with the real pipeline
    python ml/evaluate.py              # metrics, cross-checks and charts -> ml/results.md

The pipeline runs in Node. This script is the independent check, in Python
with scikit-learn:

1. Detection - using the true labels the benchmark knows: how many abusive
   merchants are caught, and how many honest ones are wrongly warned?
2. Rules - what each cleaning rule is worth (same data, one rule off at a time).
3. Clustering quality - do the k-means groups line up with the true behaviour?
4. Cross-check - scikit-learn's own KMeans and DBSCAN, run on the same six
   features with the same settings, should agree with the hand-written
   JavaScript versions.
5. Choosing the settings - elbow and silhouette for k, the k-distance curve for eps.
"""
import sys
from pathlib import Path

import matplotlib

matplotlib.use("Agg")  # write image files; no window needed
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from sklearn.cluster import DBSCAN, KMeans
from sklearn.decomposition import PCA
from sklearn.metrics import adjusted_rand_score, precision_score, recall_score, silhouette_score
from sklearn.neighbors import NearestNeighbors

HERE = Path(__file__).resolve().parent
DATA = HERE / "data" / "benchmark.csv"
FIGURES = HERE / "figures"
REPORT = HERE / "results.md"

FEATURES = ["price_volatility", "price_change_frequency", "stealth_price_changes",
            "rename_frequency", "cancellation_friction", "retry_aggressiveness"]
LABELS = ["NORMAL", "AGGRESSIVE", "ABUSIVE"]
BANDS = ["HEALTHY", "NEEDS_ATTENTION", "HIGH_RISK", "CRITICAL"]
VARIANTS = {  # column suffix -> description
    "": "All rules on (production)",
    "_no_name_normalisation": "Name normalisation off",
    "_same_day_dedupe": "De-duplicate on same subscription + amount + day",
    "_prices_from_all_attempts": "Price range from all attempts (declined included)",
}
K, EPS, MIN_SAMPLES = 3, 0.3, 2  # the pipeline's own settings (api/src/services/cronScheduler.js)


def pct(x):
    return f"{100 * x:.1f}%"


def markdown(df):
    """A pandas table as a markdown table (no extra dependency needed)."""
    header = [df.index.name or ""] + [str(c) for c in df.columns]
    lines = ["| " + " | ".join(header) + " |", "|" + "---|" * len(header)]
    lines += ["| " + " | ".join([str(i)] + [str(v) for v in row]) + " |" for i, row in zip(df.index, df.values)]
    return "\n".join(lines)


# --- 1 and 2: detection, for production and for each rule switched off ---------

def detection(df, band_column):
    warned = df[band_column] != "HEALTHY"
    flagged = df[band_column].isin(["HIGH_RISK", "CRITICAL"])
    abusive, aggressive, normal = (df.label == "ABUSIVE"), (df.label == "AGGRESSIVE"), (df.label == "NORMAL")
    return {
        "Abusive caught (high risk or critical)": recall_score(abusive, flagged),
        "Aggressive warned (not healthy)": warned[aggressive].mean(),
        "Honest wrongly warned": warned[normal].mean(),
        "Warnings that were right (precision)": precision_score(~normal, warned, zero_division=0),
    }


# --- 4: the JavaScript k-means starts from fixed centres; reproduce them -------

def javascript_initial_centroids(X, k):
    """Same rule as kmeansAnalysis.js: sort by average signal, take k evenly spaced merchants."""
    order = np.argsort(X.mean(axis=1), kind="stable")
    positions = [int(np.floor(i * (len(X) - 1) / max(1, k - 1))) for i in range(k)]
    return X[order[positions]]


def main():
    if not DATA.exists():
        sys.exit("ml/data/benchmark.csv not found - run first:  npm --prefix api run benchmark")
    df = pd.read_csv(DATA)
    df["outlier"] = df["outlier"].astype(str).str.lower() == "true"
    X = df[FEATURES].to_numpy()
    FIGURES.mkdir(exist_ok=True)

    # 1. Detection
    production = detection(df, "band")
    confusion = pd.crosstab(df.label, df.band).reindex(index=LABELS, columns=BANDS, fill_value=0)
    confusion.index.name = "True behaviour"

    # 2. Rule ablation
    ablation = pd.DataFrame({desc: detection(df, f"band{suffix}") for suffix, desc in VARIANTS.items()}).T
    ablation = ablation[["Abusive caught (high risk or critical)", "Aggressive warned (not healthy)",
                         "Honest wrongly warned"]].map(pct)
    ablation.index.name = "Pipeline"

    # 3. Clustering quality
    groups = pd.crosstab(df.label, df.cluster).reindex(index=LABELS, fill_value=0)
    groups.index.name = "True behaviour"
    ari_vs_truth = adjusted_rand_score(df.label, df.cluster_index)
    silhouette = silhouette_score(X, df.cluster_index)
    outliers_by_label = df.groupby("label").outlier.mean().reindex(LABELS)

    # 4. Cross-check against scikit-learn
    sk_kmeans = KMeans(n_clusters=K, init=javascript_initial_centroids(X, K), n_init=1,
                       max_iter=100, tol=0.0, algorithm="lloyd").fit(X)
    kmeans_agreement = adjusted_rand_score(df.cluster_index, sk_kmeans.labels_)
    sk_outlier = DBSCAN(eps=EPS, min_samples=MIN_SAMPLES).fit(X).labels_ == -1
    dbscan_agreement = float((sk_outlier == df.outlier).mean())

    # 5a. Choosing k: elbow (inertia) and silhouette for k = 2..6
    k_rows = []
    for k in range(2, 7):
        model = KMeans(n_clusters=k, n_init=10, random_state=0).fit(X)
        k_rows.append({"k": k, "inertia": round(model.inertia_, 1),
                       "silhouette": round(silhouette_score(X, model.labels_), 3)})
    k_table = pd.DataFrame(k_rows).set_index("k")

    # 5b. Choosing eps: distance from each merchant to its nearest other merchant
    distances, _ = NearestNeighbors(n_neighbors=MIN_SAMPLES).fit(X).kneighbors(X)
    nearest = np.sort(distances[:, MIN_SAMPLES - 1])
    beyond_eps = float((nearest > EPS).mean())

    # --- charts ----------------------------------------------------------------
    colours = {"NORMAL": "#2a9d8f", "AGGRESSIVE": "#e9c46a", "ABUSIVE": "#e76f51"}
    points = PCA(n_components=2, random_state=0).fit_transform(X)
    fig, ax = plt.subplots(figsize=(7, 5))
    for label in LABELS:
        mask = (df.label == label).to_numpy()
        ax.scatter(points[mask, 0], points[mask, 1], s=14, alpha=0.7, label=label, color=colours[label])
    ax.scatter(points[df.outlier, 0], points[df.outlier, 1], s=60, facecolors="none", edgecolors="black",
               linewidths=0.8, label="DBSCAN outlier")
    ax.set(title="500 benchmark merchants, six features squeezed to 2-D (PCA)",
           xlabel="principal component 1", ylabel="principal component 2")
    ax.legend()
    fig.tight_layout()
    fig.savefig(FIGURES / "pca_by_label.png", dpi=150)

    fig, (left, right) = plt.subplots(1, 2, figsize=(10, 4))
    left.plot(k_table.index, k_table.inertia, marker="o")
    left.set(title="Elbow: inertia by k", xlabel="k", ylabel="inertia (within-group spread)")
    right.plot(k_table.index, k_table.silhouette, marker="o", color="#e76f51")
    right.set(title="Silhouette by k (higher = better separated)", xlabel="k", ylabel="silhouette")
    fig.tight_layout()
    fig.savefig(FIGURES / "choosing_k.png", dpi=150)

    fig, ax = plt.subplots(figsize=(7, 4))
    ax.plot(nearest)
    ax.axhline(EPS, color="#e76f51", linestyle="--", label=f"eps = {EPS}")
    ax.set(title="k-distance curve: each merchant's distance to its nearest neighbour",
           xlabel="merchants, sorted", ylabel="distance")
    ax.legend()
    fig.tight_layout()
    fig.savefig(FIGURES / "k_distance.png", dpi=150)

    # --- report ----------------------------------------------------------------
    counts = df.label.value_counts().reindex(LABELS)
    lines = [
        "# ML evaluation on the labelled benchmark",
        "",
        "Generated by `python ml/evaluate.py` from `ml/data/benchmark.csv` "
        "(built by `npm --prefix api run benchmark` with the real pipeline).",
        "",
        f"**Data:** {len(df)} synthetic merchants, {counts.NORMAL} normal, {counts.AGGRESSIVE} aggressive and "
        f"{counts.ABUSIVE} abusive. They are synthetic, so the true answer is known. That also means these numbers "
        "show the pipeline separates the behaviours it was designed to catch, **not** real-world accuracy.",
        "",
        "## 1. Detection (production pipeline)",
        "",
        "| Measure | Result |",
        "|---|---|",
    ]
    lines += [f"| {name} | {pct(value)} |" for name, value in production.items()]
    lines += ["", "Every merchant by true behaviour and the band it was given:", "", markdown(confusion),
              "", "## 2. What each cleaning rule is worth", "",
              "The same 500 merchants, with one rule switched off at a time:", "", markdown(ablation),
              "", "## 3. Clustering quality", "",
              "True behaviour against the k-means group each merchant landed in (groups are named from their centre):",
              "", markdown(groups), "",
              f"- Adjusted Rand index, k-means groups vs true behaviour: **{ari_vs_truth:.3f}** "
              "(1 = identical grouping, 0 = no better than chance)",
              f"- Silhouette score of the k-means groups: **{silhouette:.3f}** (from -1 to 1; higher = tighter, "
              "better separated groups)",
              "- Share flagged as DBSCAN outliers: " + ", ".join(
                  f"{label.lower()} {pct(outliers_by_label[label])}" for label in LABELS),
              "", "## 4. Cross-check: hand-written JavaScript vs scikit-learn", "",
              f"- k-means: scikit-learn `KMeans` from the same starting centres, agreement (adjusted Rand index): "
              f"**{kmeans_agreement:.3f}**",
              f"- DBSCAN: scikit-learn `DBSCAN(eps={EPS}, min_samples={MIN_SAMPLES})`, same outlier decision for "
              f"**{pct(dbscan_agreement)}** of merchants",
              "", "## 5. Choosing the settings", "",
              "k for k-means (scikit-learn, 10 random starts each):", "", markdown(k_table), "",
              "![Choosing k](figures/choosing_k.png)", "",
              f"eps for DBSCAN: {pct(beyond_eps)} of merchants have no other merchant within {EPS}. "
              f"Nearest-neighbour distance percentiles: 50th {np.percentile(nearest, 50):.3f}, "
              f"90th {np.percentile(nearest, 90):.3f}, 95th {np.percentile(nearest, 95):.3f}, "
              f"99th {np.percentile(nearest, 99):.3f}.", "",
              "![k-distance curve](figures/k_distance.png)", "",
              "![PCA view of the benchmark](figures/pca_by_label.png)", ""]
    REPORT.write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()

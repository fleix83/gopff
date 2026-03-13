#!/usr/bin/env python3
"""
gopff! - Swiss Company Fetcher
================================
Downloads ALL active Swiss companies from the official commercial register (Zefix).

Two approaches included:
  1) CSV Download: From Open Data Basel-Stadt (pre-processed daily CSVs per canton)
  2) SPARQL Query: Directly from LINDAS (the federal linked data service)

Both sources contain the same Zefix data, updated daily.

Output: A clean CSV with columns: company_name, municipality, canton

Usage:
  python fetch_swiss_companies.py              # Uses CSV approach (default)
  python fetch_swiss_companies.py --sparql     # Uses SPARQL approach
  python fetch_swiss_companies.py --supabase   # CSV approach + upload to Supabase
"""

import csv
import io
import json
import os
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime

# ============================================================
# CONFIG
# ============================================================

CANTONS = [
    "ZH", "BE", "LU", "UR", "SZ", "OW", "NW", "GL", "ZG", "FR",
    "SO", "BS", "BL", "SH", "AR", "AI", "SG", "GR", "AG", "TG",
    "TI", "VD", "VS", "NE", "GE", "JU"
]

CSV_BASE_URL = "https://data-bs.ch/stata/zefix_handelsregister/all_cantons/companies_{}.csv"
SPARQL_ENDPOINT = "https://lindas.admin.ch/query"
OUTPUT_FILE = "swiss_companies_gopff.csv"


# ============================================================
# APPROACH 1: CSV Download
# ============================================================

def download_canton_csv(canton, retries=3):
    url = CSV_BASE_URL.format(canton)
    for attempt in range(retries):
        try:
            print(f"  [{canton}] Downloading...", end=" ", flush=True)
            req = urllib.request.Request(url, headers={"User-Agent": "gopff-fetcher/1.0"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                raw = resp.read()
                try:
                    text = raw.decode("utf-8")
                except UnicodeDecodeError:
                    text = raw.decode("latin-1")

            reader = csv.DictReader(io.StringIO(text))
            rows = []
            for row in reader:
                name = (row.get("company_legal_name", "") or row.get("name", "")).strip()
                municipality = row.get("municipality", "").strip()
                canton_short = row.get("short_name_canton", "").strip()
                if not canton_short or len(canton_short) != 2:
                    canton_short = canton
                if name:
                    rows.append({"company_name": name, "municipality": municipality, "canton": canton_short})

            print(f"OK ({len(rows):,} companies)")
            return rows
        except Exception as e:
            print(f"FAILED ({e})")
            if attempt < retries - 1:
                time.sleep(2 ** attempt)

    print(f"  Warning: Skipping {canton} after {retries} attempts")
    return []


def fetch_all_csv():
    all_companies = []
    failed = []
    for canton in CANTONS:
        rows = download_canton_csv(canton)
        if rows:
            all_companies.extend(rows)
        else:
            failed.append(canton)
        time.sleep(0.3)
    if failed:
        print(f"\n  Warning: Failed cantons: {', '.join(failed)}")
    return all_companies


# ============================================================
# APPROACH 2: SPARQL (LINDAS)
# ============================================================

SPARQL_PER_CANTON = """
PREFIX schema: <http://schema.org/>
PREFIX admin: <https://schema.ld.admin.ch/>

SELECT ?company_legal_name ?municipality ?short_name_canton
FROM <https://lindas.admin.ch/foj/zefix>
FROM <https://lindas.admin.ch/territorial>
WHERE {{
    ?sub a admin:ZefixOrganisation ;
         schema:name ?company_legal_name ;
         admin:municipality ?muni_id .
    ?muni_id schema:name ?municipality .
    FILTER(LANG(?municipality) = "de")
    ?muni_id schema:containedInPlace ?district .
    ?district schema:containedInPlace <https://ld.admin.ch/canton/{canton_id}> .
    <https://ld.admin.ch/canton/{canton_id}> schema:alternateName ?short_name_canton .
}}
ORDER BY ?company_legal_name
"""


def sparql_query(query):
    data = urllib.parse.urlencode({"query": query}).encode("utf-8")
    req = urllib.request.Request(
        SPARQL_ENDPOINT,
        data=data,
        headers={
            "Accept": "application/sparql-results+json",
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "gopff-fetcher/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        result = json.loads(resp.read().decode("utf-8"))

    rows = []
    for b in result.get("results", {}).get("bindings", []):
        rows.append({
            "company_name": b.get("company_legal_name", {}).get("value", ""),
            "municipality": b.get("municipality", {}).get("value", ""),
            "canton": b.get("short_name_canton", {}).get("value", ""),
        })
    return rows


def fetch_all_sparql():
    all_companies = []
    for i, canton in enumerate(CANTONS, 1):
        print(f"  [{canton}] Querying LINDAS ({i}/26)...", end=" ", flush=True)
        try:
            query = SPARQL_PER_CANTON.format(canton_id=i)
            rows = sparql_query(query)
            print(f"OK ({len(rows):,} companies)")
            all_companies.extend(rows)
        except Exception as e:
            print(f"FAILED ({e})")
        time.sleep(1)
    return all_companies


# ============================================================
# SUPABASE UPLOAD
# ============================================================

SUPABASE_SQL = """
-- Run this in your Supabase SQL editor BEFORE uploading:

CREATE TABLE IF NOT EXISTS companies (
    id BIGSERIAL PRIMARY KEY,
    company_name TEXT NOT NULL,
    municipality TEXT,
    canton VARCHAR(2),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(company_name, municipality, canton)
);

CREATE INDEX IF NOT EXISTS idx_companies_canton ON companies(canton);
CREATE INDEX IF NOT EXISTS idx_companies_municipality ON companies(municipality);
CREATE INDEX IF NOT EXISTS idx_companies_name_search
    ON companies USING gin(to_tsvector('german', company_name));
"""


def upload_to_supabase(companies):
    try:
        from supabase import create_client
    except ImportError:
        print("ERROR: pip install supabase")
        sys.exit(1)

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_KEY")
    if not url or not key:
        print("ERROR: Set SUPABASE_URL and SUPABASE_KEY environment variables")
        sys.exit(1)

    client = create_client(url, key)
    batch_size = 500
    total = len(companies)

    for i in range(0, total, batch_size):
        batch = companies[i:i + batch_size]
        n = i // batch_size + 1
        print(f"  Batch {n} ({i+1}-{min(i+batch_size, total)}/{total})...", end=" ", flush=True)
        try:
            client.table("companies").upsert(batch, on_conflict="company_name,municipality,canton").execute()
            print("OK")
        except Exception as e:
            print(f"FAILED ({e})")
        time.sleep(0.1)

    print("  Upload complete!")


# ============================================================
# MAIN
# ============================================================

def deduplicate(companies):
    seen = set()
    unique = []
    for c in companies:
        key = (c["company_name"], c["municipality"], c["canton"])
        if key not in seen:
            seen.add(key)
            unique.append(c)
    unique.sort(key=lambda x: (x["canton"], x["municipality"], x["company_name"]))
    return unique


def main():
    use_sparql = "--sparql" in sys.argv
    upload_sb = "--supabase" in sys.argv
    show_sql = "--sql" in sys.argv

    if show_sql:
        print(SUPABASE_SQL)
        return

    method = "SPARQL (LINDAS)" if use_sparql else "CSV (data-bs.ch)"
    print("=" * 60)
    print(f"gopff! Swiss Company Fetcher")
    print(f"Date:   {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"Method: {method}")
    print("=" * 60)

    companies = fetch_all_sparql() if use_sparql else fetch_all_csv()
    companies = deduplicate(companies)

    with open(OUTPUT_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["company_name", "municipality", "canton"])
        writer.writeheader()
        writer.writerows(companies)

    cantons_found = set(c["canton"] for c in companies)
    canton_counts = {}
    for c in companies:
        canton_counts[c["canton"]] = canton_counts.get(c["canton"], 0) + 1

    print(f"\n{'=' * 60}")
    print(f"DONE! {len(companies):,} companies from {len(cantons_found)} cantons")
    print(f"File:  {OUTPUT_FILE}")
    print(f"{'=' * 60}")

    top5 = sorted(canton_counts.items(), key=lambda x: -x[1])[:5]
    print(f"\nTop cantons: {', '.join(f'{c}: {n:,}' for c, n in top5)}")

    if upload_sb:
        print(f"\nUploading to Supabase...")
        upload_to_supabase(companies)


if __name__ == "__main__":
    main()

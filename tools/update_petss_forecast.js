#!/usr/bin/env node
/**
 * Update PETSS forecast (ensemble mean) from NOMADS PETSS production tarballs.
 *
 * Outputs:
 *  - data/petss_forecast.csv   (time_utc_iso, twl_ft_mllw, tide_ft_mllw, surge_ft, src_time)
 *  - data/petss_forecast.json  ([{ t: "...Z", twl, tide, surge }...])
 *  - data/petss_meta.json      ({ stid, datum, run_dir, cycle, source_url, updated_utc, n_points })
 *
 * Env:
 *  - PETSS_STID  (required) e.g. "8531804"
 *  - PETSS_DATUM (optional; metadata only) e.g. "MLLW"
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");
const { execFileSync } = require("child_process");

const BASE = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/petss/prod/";

function log(...a) { console.log(...a); }
function die(msg, err) {
  console.error(msg);
  if (err) console.error(err.stack || err);
  process.exit(1);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function fetchText(url) {
  // NOMADS intermittently resets HTTP/2 streams. curl's HTTP/1.1 path is bounded
  // and retries transient network failures on both macOS and GitHub's Ubuntu runner.
  return execFileSync("curl",["--http1.1","--fail","--silent","--show-error","--location","--retry","2","--max-time","45",url],{encoding:"utf8",maxBuffer:8*1024*1024});
}

function downloadFile(url, outPath) {
  execFileSync("curl",["--http1.1","--fail","--silent","--show-error","--location","--retry","2","--max-time","45",url,"--output",outPath],{stdio:"inherit"});
}

function listLatestProdDir(html) {
  // Expect directory names like petss.20260131/
  const re = /petss\.(\d{8})\/?/g;
  const dates = [];
  let m;
  while ((m = re.exec(html)) !== null) dates.push(m[1]);
  if (!dates.length) throw new Error("Could not find petss.YYYYMMDD directories in NOMADS listing.");
  dates.sort(); // ascending
  const latest = dates[dates.length - 1];
  return `petss.${latest}/`;
}

function chooseCycleTarball(html) {
  // Prefer t18z, then t12z, t06z, t00z. We want the station CSV tarball.
  const preferred = ["t18z", "t12z", "t06z", "t00z"];
  for (const cyc of preferred) {
    const name = `petss.${cyc}.csv.tar.gz`;
    if (html.includes(name)) return name;
  }
  // Fallback: pick ANY petss.t??z.csv.tar.gz
  const m = html.match(/petss\.t\d{2}z\.csv\.tar\.gz/g);
  if (m && m.length) return m.sort().pop();
  throw new Error("Could not find any petss.t??z.csv.tar.gz tarball in run dir listing.");
}

function findFileRecursive(rootDir, filename) {
  const stack = [rootDir];
  while (stack.length) {
    const d = stack.pop();
    const ents = fs.readdirSync(d, { withFileTypes: true });
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name === filename) return p;
    }
  }
  return null;
}

function parseNomadsStationCsv(text, stid) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

  // Find header line containing TIME and TWL
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].trim();
    if (h.toUpperCase().includes("TIME") && h.toUpperCase().includes("TWL")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    throw new Error(`Could not find NOMADS header row with TIME/TWL for STID=${stid}`);
  }

  const header = lines[headerIdx].split(",").map((s) => s.trim().toUpperCase());
  const idxTIME = header.indexOf("TIME");
  const idxTWL = header.indexOf("TWL");
  const idxTIDE = header.indexOf("TIDE");
  const idxSURGE = header.indexOf("SURGE");

  if (idxTIME === -1 || idxTWL === -1) {
    throw new Error(`Header missing TIME or TWL for STID=${stid}. Header=${header.join("|")}`);
  }

  function parseNum(s) {
    if(s == null || String(s).trim() === "") return null;
    const v = Number(String(s).trim());
    if (!Number.isFinite(v)) return null;
    // NOMADS uses 9999.000 as missing
    if (Math.abs(v) >= 999) return null;
    return v;
  }

  function parseTimeYYYYMMDDHHMM(s) {
    const t = String(s).trim();
    // Expect 12 digits: YYYYMMDDHHMM
    if (!/^\d{12}$/.test(t)) return null;
    const Y = Number(t.slice(0, 4));
    const M = Number(t.slice(4, 6));
    const D = Number(t.slice(6, 8));
    const h = Number(t.slice(8, 10));
    const m = Number(t.slice(10, 12));
    // UTC Date
    const dt = new Date(Date.UTC(Y, M - 1, D, h, m, 0));
    if (Number.isNaN(dt.getTime())) return null;
    return dt;
  }

  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    // skip separators or junk
    if (!/^\d{12}\s*,/.test(line)) continue;

    const parts = line.split(",").map((s) => s.trim());
    const dt = parseTimeYYYYMMDDHHMM(parts[idxTIME]);
    if (!dt) continue;

    const tide = idxTIDE >= 0 ? parseNum(parts[idxTIDE]) : null;
    const surge = idxSURGE >= 0 ? parseNum(parts[idxSURGE]) : null;
    const twl = parseNum(parts[idxTWL]);

    // Ensemble mean TWL is TWL when present; fallback to tide+surge if TWL missing but both exist
    const twlBest =
      twl != null ? twl :
      (tide != null && surge != null ? (tide + surge) : null);

    // For plotting: keep only points with a usable ensemble mean
    if (twlBest == null) continue;

    rows.push({
      t: dt.toISOString(),
      twl: Number(twlBest.toFixed(3)),
      tide: tide != null ? Number(tide.toFixed(3)) : null,
      surge: surge != null ? Number(surge.toFixed(3)) : null,
      src_time: String(parts[idxTIME]).trim()
    });
  }

  if (!rows.length) {
    throw new Error(
      `Parsed 0 usable rows (no valid TWL or TIDE+SURGE). ` +
      `This can happen if the file is mostly 9999 missing values.`
    );
  }

  // Sort time ascending
  rows.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return rows;
}

async function main() {
  const stid = process.env.PETSS_STID?.trim();
  const datum = (process.env.PETSS_DATUM || "MLLW").trim();

  if (!/^\d{7}$/.test(stid || "")) die("PETSS_STID must be a seven-digit NOAA station identifier.");
  if(datum !== "MLLW") die("Station CSV levels are MLLW; relabeling them is not a datum conversion.");

  log("Running PETSS forecast updater via NOMADS…");
  log("STID:", stid);
  log("DATUM (for metadata only):", datum);
  log("Base:", BASE);

  // 1) Find latest run dir
  const baseHtml = await fetchText(BASE);
  const runDirs = [...new Set([...baseHtml.matchAll(/petss\.(\d{8})\//g)].map(m=>`petss.${m[1]}/`))].sort().reverse().slice(0,3);
  let selected;
  const failures = [];
  for(const runDir of runDirs){
    let runHtml;
    try{runHtml = await fetchText(BASE + runDir);}catch(e){failures.push(String(e));continue;}
    for(const hour of ["18","12","06","00"]){
      const cycle = `t${hour}z`, tarball = `petss.${cycle}.csv.tar.gz`;
      if(!runHtml.includes(tarball)) continue;
      const date = runDir.match(/\d{8}/)[0];
      const issuedTime = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}T${hour}:00:00Z`;
      if(Date.now() - Date.parse(issuedTime) > 48*3600000) continue;
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(),"crest-petss-"));
      const tgz = path.join(tmp,tarball), url = BASE + runDir + tarball;
      try{
        log("Trying complete station run:",url);
        await downloadFile(url,tgz);
        const names = execFileSync("tar",["-tzf",tgz],{encoding:"utf8",maxBuffer:4*1024*1024}).split(/\r?\n/);
        const member = names.find(n=>n.split("/").at(-1) === `${stid}.csv`);
        if(!member || member.startsWith("/") || member.split("/").includes("..")) throw new Error("Missing or invalid station member");
        const stationText = execFileSync("tar",["-xOzf",tgz,member],{encoding:"utf8",maxBuffer:8*1024*1024});
        const rows = parseNomadsStationCsv(stationText,stid);
        if(Date.parse(rows.at(-1).t) < Date.now()+72*3600000) throw new Error("Run does not cover the next 72 hours");
        selected = {runDir,cycle,url,issuedTime,stationText,rows};
      }catch(e){failures.push(`${url}: ${e.message}`);}
      finally{fs.rmSync(tmp,{recursive:true,force:true});}
      if(selected) break;
    }
    if(selected) break;
  }
  if(!selected) throw new Error("No fresh complete PETSS station run; existing forecast preserved. " + failures.join(" | "));
  const {runDir,cycle,url,issuedTime,stationText,rows} = selected;
  ensureDir("data");
  fs.writeFileSync("data/petss_station_debug.txt",stationText.split(/\r?\n/).slice(0,250).join("\n")+"\n","utf8");

  // 6) Write outputs
  const outCsv = [
    "time_utc_iso,twl_ft_mllw,tide_ft_mllw,surge_ft,src_time",
    ...rows.map(r => {
      const tide = (r.tide == null ? "" : r.tide);
      const surge = (r.surge == null ? "" : r.surge);
      return `${r.t},${r.twl},${tide},${surge},${r.src_time}`;
    })
  ].join("\n") + "\n";

  fs.writeFileSync("data/petss_forecast.csv", outCsv, "utf8");
  fs.writeFileSync("data/petss_forecast.json", JSON.stringify(rows, null, 2) + "\n", "utf8");

  const meta = {
    stid,
    datum,
    run_dir: runDir.replace(/\/$/, ""),
    cycle,
    source_url: url,
    model_time_utc: issuedTime,
    valid_through_utc: rows.at(-1).t,
    updated_utc: new Date().toISOString(),
    n_points: rows.length,
    notes: "Ensemble mean plotted as TWL (fallback to TIDE+SURGE when TWL missing)."
  };
  fs.writeFileSync("data/petss_meta.json", JSON.stringify(meta, null, 2) + "\n", "utf8");

  log(`Wrote ${rows.length} points → data/petss_forecast.csv + .json + meta`);
}

if(require.main === module) main().catch((e) => {
  try {
    ensureDir("data");
    fs.writeFileSync("data/petss_error.txt", String(e && (e.stack || e.message || e)) + "\n", "utf8");
  } catch (_) {}
  die("PETSS update failed:", e);
});
module.exports = {parseNomadsStationCsv, listLatestProdDir, chooseCycleTarball};

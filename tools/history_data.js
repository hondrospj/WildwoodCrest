"use strict";

const TZ = "America/New_York";
const PRIMARY_START = "2000-05-29";
const partsFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone:TZ, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", hourCycle:"h23"
});

function localParts(iso){
  const date = new Date(iso);
  if(!Number.isFinite(date.getTime())) return null;
  const p = Object.fromEntries(partsFormatter.formatToParts(date).map(x=>[x.type,x.value]));
  return {date:`${p.year}-${p.month}-${p.day}`, y:+p.year, m:+p.month, d:+p.day, bucket:+p.hour < 12 ? "AM" : "PM"};
}

function validLevel(raw, noData){
  if(raw == null || String(raw).trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n !== Number(noData ?? -999999) && Math.abs(n) < 100 ? n : null;
}

function classify(ft, thresholds){
  return ft >= thresholds.majorLow ? "Major" : ft >= thresholds.moderateLow ? "Moderate" : ft >= thresholds.minorLow ? "Minor" : "Below";
}

function bucketEvents(points, agency, station, name, thresholds){
  const best = new Map();
  for(const p of points){
    const ft = validLevel(p.ft);
    const local = localParts(p.t);
    if(ft == null || !local) continue;
    const key = `${local.date}|${local.bucket}`;
    const previous = best.get(key);
    if(previous && previous.ft >= ft) continue;
    best.set(key, {
      t:new Date(p.t).toISOString(), crest:new Date(p.t).toISOString(), ft,
      type:classify(ft, thresholds), kind:"StitchedHighTide", historyAgency:agency,
      historySource:`${agency} ${station} ${name}`, sourceStation:station, sourceName:name,
      sourceRole:agency === "USGS" ? "local gauge" : "pre-local-gauge unadjusted NAVD88 surrogate",
      sourceBucket:local.bucket, localDate:local.date, y:local.y, m:local.m, d:local.d
    });
  }
  return [...best.values()];
}

function countableEvents(events){
  const officialByDate = new Map();
  const regular = new Map();
  for(const e of events){
    const p = localParts(e.t), ft = validLevel(e.ft);
    if(!p || ft == null) continue;
    const date = e.localDate || p.date;
    const target = e.officialCrestOverride ? officialByDate : regular;
    const key = e.officialCrestOverride ? date : `${date}|${e.sourceBucket || p.bucket}`;
    if(!target.has(key) || Number(target.get(key).ft) < ft) target.set(key,e);
  }
  return [...regular.values()].filter(e=>!officialByDate.has(e.localDate || localParts(e.t).date))
    .concat([...officialByDate.values()]);
}

function annualCounts(events, coverageYears, thresholds, currentYear){
  const counts = new Map();
  for(const e of countableEvents(events)){
    const year = Number(e.y ?? localParts(e.t).y);
    if(!counts.has(year)) counts.set(year,{minor:0, moderate:0, major:0});
    const type = classify(Number(e.ft),thresholds).toLowerCase();
    if(type !== "below") counts.get(year)[type]++;
  }
  const coverage = new Set([...coverageYears,...counts.keys()]);
  const first = Math.min(currentYear,...coverage);
  return Array.from({length:currentYear-first+1},(_,i)=>{
    const year = first+i, available = coverage.has(year);
    return {year, ...(available ? counts.get(year) || {minor:0,moderate:0,major:0} : {minor:null,moderate:null,major:null}), available};
  });
}

module.exports = {TZ, PRIMARY_START, localParts, validLevel, classify, bucketEvents, countableEvents, annualCounts};

#!/usr/bin/env node
"use strict";

// Reproducible stitched archive. Preserve every official crest in the catalogue;
// date authority is applied only when counting floods, never by deleting crests.
const fs = require("node:fs");
const path = require("node:path");
const {PRIMARY_START, localParts, validLevel, bucketEvents, annualCounts} = require("./history_data");
const root = path.resolve(__dirname,"..");
const cachePath = path.join(root,"data/peaks_navd88.json");
const STATION = "01411390";
const LEWES_URL = "https://hondrospj.github.io/Wildwood-Crest-Borough-floodmapper/lewes_hourly.json";

async function getJSON(url){
  let last;
  for(let attempt=0;attempt<3;attempt++){
    try{
      const r = await fetch(url,{signal:AbortSignal.timeout(45000)});
      if(!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
      return await r.json();
    }catch(e){last=e;}
  }
  throw last;
}

async function getUSGS(start,end){
  const url = new URL("https://waterservices.usgs.gov/nwis/iv/");
  for(const [k,v] of Object.entries({format:"json",sites:STATION,parameterCd:"72279",startDT:start,endDT:end,siteStatus:"all"})) url.searchParams.set(k,v);
  const json = await getJSON(url);
  const points = new Map();
  for(const ts of json?.value?.timeSeries || []){
    if(!ts.variable?.variableCode?.some(c=>c.value === "72279")) continue;
    if(!ts.sourceInfo?.siteCode?.some(c=>c.value === STATION)) continue;
    if(ts.variable?.unit?.unitCode !== "ft") throw new Error("USGS water level units must be feet");
    for(const group of ts.values || []) for(const row of group.value || []){
      const ft = validLevel(row.value,ts.variable.noDataValue);
      if(ft != null && Number.isFinite(Date.parse(row.dateTime))) points.set(Date.parse(row.dateTime),{t:row.dateTime,ft});
    }
  }
  return [...points.values()].sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
}

async function main(){
  const cache = JSON.parse(fs.readFileSync(cachePath,"utf8"));
  const thresholds = cache.thresholdsNAVD88;
  const official = (cache.events || []).filter(e=>e.officialCrestOverride);
  const existingLocal = (cache.events || []).filter(e=>!e.officialCrestOverride && e.historyAgency === "USGS");
  const now = new Date();
  const full = process.argv.includes("--backfill");
  let lewes = [];
  const coverage = new Set(cache.coverageYears || []);
  if(full){
    const localArchive = process.argv.find(a=>a.startsWith("--lewes-file="))?.slice(13);
    const archive = localArchive ? JSON.parse(fs.readFileSync(localArchive,"utf8")) : await getJSON(LEWES_URL);
    if(archive.datum !== "NAVD88" || archive.stationId !== "8557380" || archive.units !== "feet" || archive.intervalMinutes !== 60 || archive.schema !== "shorelysafe-lewes-hourly-backfill-v1") throw new Error("Expected verified Lewes 8557380 hourly NAVD88-feet archive schema");
    // The compact archive stores integer hundredths of a foot and real sample timestamps.
    for(const day of archive.days || []){
      if(day.d >= PRIMARY_START) continue;
      const start = Number(day.u) * 1000;
      const step = Number(archive.intervalMinutes || 60) * 60000;
      const values = day.v || [];
      for(let i=0;i<values.length;i++){
        if(values[i] == null) continue;
        const ft = validLevel(Number(values[i])/100);
        const t = start + i*step;
        if(ft == null || !Number.isFinite(t)) continue;
        lewes.push({t:new Date(t).toISOString(),ft});
      }
    }
    if(!lewes.length) throw new Error("No Lewes observations decoded; preserving existing files");
    lewes = bucketEvents(lewes,"NOAA","8557380","Lewes, Delaware",thresholds);
    for(const e of lewes) coverage.add(e.y);
  }else{
    lewes = (cache.events || []).filter(e=>!e.officialCrestOverride && e.historyAgency === "NOAA");
  }

  const requests = [];
  const earliestExisting = existingLocal.reduce((v,e)=>Math.min(v,Date.parse(e.t)),now.getTime());
  if(full && earliestExisting > Date.parse(PRIMARY_START)){
    // Fetch only the missing early local record, preserving the existing later archive.
    for(let start=Date.parse(PRIMARY_START);start<earliestExisting;start+=31*86400000){
      requests.push([new Date(start).toISOString(),new Date(Math.min(earliestExisting,start+31*86400000)).toISOString()]);
    }
  }
  const last = Date.parse(cache.lastProcessedISO);
  const recentStart = Number.isFinite(last) ? Math.max(Date.parse(PRIMARY_START),last-3*86400000) : now.getTime()-7*86400000;
  requests.push([new Date(recentStart).toISOString(),now.toISOString()]);
  const results = [];
  let cursor = 0;
  await Promise.all(Array.from({length:Math.min(4,requests.length)},async()=>{
    while(cursor<requests.length){
      const index = cursor++, [start,end] = requests[index];
      const points = await getUSGS(start,end);
      results[index] = points;
      console.log(`USGS ${index+1}/${requests.length}: ${start.slice(0,10)}–${end.slice(0,10)}: ${points.length} samples`);
    }
  }));
  const newPoints = results.flat();
  if(!results.at(-1)?.length) throw new Error("Recent USGS request returned no valid levels; preserving archive");
  // Replace fully requested local dates, allowing downward quality-control revisions.
  // Preserve the leading partial date so a chunk boundary cannot erase an earlier crest.
  const recentStartDate = localParts(new Date(recentStart)).date;
  const retainedLocal = existingLocal.filter(e=>(e.localDate || localParts(e.t).date) <= recentStartDate);
  const merged = bucketEvents([...retainedLocal,...newPoints],"USGS",STATION,"Cape May Harbor",thresholds)
    .filter(e=>e.localDate >= PRIMARY_START);
  for(const e of merged) coverage.add(e.y);
  const events = [...lewes,...merged,...official].sort((a,b)=>Date.parse(a.t)-Date.parse(b.t));
  cache.events = events;
  cache.coverageYears = [...coverage].sort((a,b)=>a-b);
  cache.lastProcessedISO = new Date(Math.max(last || 0,...results.at(-1).map(p=>Date.parse(p.t)))).toISOString();
  cache.method = "stitched_civil_am_pm_maxima_with_preserved_official_crests_v3";
  cache.crestMerge = {policy:"Official crest catalogue retained unchanged; date authority only in counting views",dashboardGauge:STATION,localRecordAgency:"USGS",finalEventCount:events.length};
  cache.historyStitch = {
    schema:"shorelysafe-dashboard-history-stitch-v3",timeZone:"America/New_York",
    bucketMethod:"highest measured water level in each local civil AM/PM bucket",
    crestAuthority:"all official crests retained; highest official crest per date used only for annual flood counting",
    localGauge:{agency:"USGS",station:STATION,name:"Cape May Harbor",startDate:PRIMARY_START,endDate:localParts(cache.lastProcessedISO).date,storedTideCount:merged.length},
    preLocalSurrogate:{agency:"NOAA",station:"8557380",name:"Lewes, Delaware",startDate:"1919-02-01",endDate:"2000-05-28",storedTideCount:lewes.length,policy:"Unadjusted NOAA Lewes NAVD88 observations before local USGS record; not local measurements"},
    officialCrestCount:official.length,finalEventCount:events.length
  };
  const daysByYear = new Map();
  for(const e of [...lewes,...merged]){
    if(!daysByYear.has(e.y)) daysByYear.set(e.y,new Set());
    daysByYear.get(e.y).add(e.localDate);
  }
  cache.coverage = [...daysByYear].map(([year,days])=>({year,observedDays:days.size})).sort((a,b)=>a.year-b.year);
  const counts = annualCounts(events,coverage,thresholds,localParts(now).y).map(row=>{
    const observedDays = daysByYear.get(row.year)?.size || 0;
    const yearDays = new Date(Date.UTC(row.year,1,29)).getUTCMonth() === 1 ? 366 : 365;
    return {...row,observedDays,partial:observedDays < yearDays};
  });
  const annual = {schema:"shorelysafe-annual-flood-counts-v3",generatedAtUtc:now.toISOString(),datum:"NAVD88",thresholdsNAVD88:thresholds,station:STATION,firstYear:Math.min(...coverage),lastYear:localParts(now).y,counts};
  // Publish only after every source request and invariant passes.
  if(official.length !== cache.events.filter(e=>e.officialCrestOverride).length) throw new Error("Official crest preservation failed");
  fs.writeFileSync(cachePath,JSON.stringify(cache,null,2)+"\n");
  fs.writeFileSync(path.join(root,"data/annual_flood_counts.json"),JSON.stringify(annual,null,2)+"\n");
  console.log(`Saved ${events.length} events; ${official.length} official crests; ${annual.firstYear}–${annual.lastYear}`);
}
if(require.main === module) main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports = {getUSGS};

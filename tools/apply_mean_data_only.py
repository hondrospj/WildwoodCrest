#!/usr/bin/env python3
"""Overlay issued forecast data while preserving an already deployed static interface."""
from pathlib import Path
import sys,re,json,shutil,hashlib
source=Path(sys.argv[1]);root=Path('.')
files=[]
for path in ['forecast.json','forecasts.json','data/petss_forecast.json','data/petss_forecast.csv','data/petss_meta.json']:
 p=source/path
 if p.exists():
  dest=root/path;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dest);files.append(path)
for p in (source/'data/gauges').glob('*/petss*')if(source/'data/gauges').exists()else[]:
 if p.is_file()and p.suffix in ['.json','.csv']:
  dest=root/p.relative_to(source);dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dest);files.append(str(p.relative_to(source)))
assert files,'No forecast files to deploy'
index=root/'index.html';before=index.read_text();after=before
SIMPLE='''function getForecastScenarioHours(data = forecastData, scenario = currentForecastScenario) {
      if (!data) return [];
      const record = data.scenarioForecasts?.[scenario] || data.forecasts?.[scenario];
      if (Array.isArray(record?.hours)) return record.hours;
      return scenario === "mean" && Array.isArray(data.hours) ? data.hours : [];
    }'''
# Only the forecast selector and provenance constants may change in the deployed HTML.
after=re.sub(r'function getForecastScenarioHours\([^)]*\)\s*\{[\s\S]*?\n    \}',SIMPLE,after,count=1)
m=re.search(r'(const FORECAST_SCENARIOS\s*=\s*\{)([\s\S]*?)(\n\s*\};)',after)
if m:
 block=m[0]
 for key,label in [('mean','Mean'),('lowEnd','90p / e90'),('highEnd','10p / e10')]:block=re.sub(r'('+key+r':\s*\{[^\n]*percentile:\s*)"[^"]+"',lambda v:v[1]+json.dumps(label),block)
 after=after[:m.start()]+block+after[m.end():]
for old in ['https://shorelysafe-outreach-tools.hondrosp.chatgpt.site/api/waretown/forecast.json','https://wilmington-flood-tools.hondrosp.chatgpt.site/api/wilmington/forecast.json']:after=after.replace(old,'./forecast.json')
def ui(s):
 s=re.sub(r'const FORECAST_SCENARIOS\s*=\s*\{[\s\S]*?\n\s*\};','DATA',s);s=re.sub(r'function getForecastScenarioHours\([^)]*\)\s*\{[\s\S]*?\n    \}','SELECTOR',s)
 for old in ['https://shorelysafe-outreach-tools.hondrosp.chatgpt.site/api/waretown/forecast.json','https://wilmington-flood-tools.hondrosp.chatgpt.site/api/wilmington/forecast.json']:s=s.replace(old,'./forecast.json')
 return s
assert ui(before)==ui(after),'Unexpected UI change in data-only publication'
index.write_text(after);print(json.dumps({'forecastFiles':files,'uiInvariantSha256':hashlib.sha256(ui(after).encode()).hexdigest(),'interfacePreserved':True}))

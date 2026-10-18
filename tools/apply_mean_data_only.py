import re

NORMALIZER=re.compile(r'function normalizePetssJsonToPoints\([^)]*\)\s*\{[\s\S]*?\n\}')
ALIGNMENT=re.compile(r'function alignPetssForecastWithObservation\([^)]*\)\s*\{[\s\S]*?\n\}')
NATIVE=re.compile(r'function getStageValue\(entry\)\s*\{[\s\S]*?\n    \}')

def patch_data_reader(text):
 def normalizer(m):
  block,n=re.subn(r'const value = [^;]+;', 'const value = p.source_twl_mean ?? p.twl;',m[0],count=1)
  assert n==1
  return block
 text=NORMALIZER.sub(normalizer,text)
 # The issued NOAA mean must not be shifted to a recent observation.
 text=ALIGNMENT.sub('function alignPetssForecastWithObservation(points){\n  return {points, alignment:null};\n}',text)
 def native(m):
  return m[0].replace('entry.sourceColumn === "TWL90p" ? raw', '(entry.sourceColumn === "TWL" || entry.sourceColumn === "TWL90p") ? raw')
 text=NATIVE.sub(native,text)
 text=text.replace('const adjusted = ForecastPeakAnchors.apply(points || []);','const adjusted = {points:points || [], applied:[]};')
 return text

def ui_invariant(text):
 # Only these forecast ingestion functions may change. Every other byte,
 # including all HTML, CSS, labels, controls and rendering code, is retained.
 for pattern in [NORMALIZER,ALIGNMENT,NATIVE]:text=pattern.sub('FORECAST_DATA_INGESTION',text)
 text=text.replace('const adjusted = ForecastPeakAnchors.apply(points || []);','const adjusted = {points:points || [], applied:[]};')
 return text

from pathlib import Path
import sys,shutil,json,hashlib
source=Path(sys.argv[1]);root=Path('.')
files=[]
for p in [source/'data/petss_forecast.json',source/'data/petss_forecast.csv',source/'data/petss_meta.json']:
 if p.exists():
  target=root/p.relative_to(source);target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,target);files.append(str(p.relative_to(source)))
assert files,'No forecast data to publish'
p=root/'index.html';before=p.read_text();after=patch_data_reader(before)
assert ui_invariant(before)==ui_invariant(after),'Unexpected interface change'
p.write_text(after)
print(json.dumps({'forecastFiles':files,'interfacePreserved':True,'uiInvariantSha256':hashlib.sha256(ui_invariant(after).encode()).hexdigest()}))

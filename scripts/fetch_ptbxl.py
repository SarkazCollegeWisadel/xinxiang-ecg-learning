"""Fetch only a few public PTB-XL records; retain original headers and provenance."""
import ast, csv, io, json, pathlib, struct, urllib.request, hashlib
ROOT=pathlib.Path(__file__).resolve().parents[1]
BASE='https://physionet.org/files/ptb-xl/1.0.3/'
def get(path):
    with urllib.request.urlopen(BASE+path,timeout=60) as r:return r.read()
out=ROOT/'public'/'data';out.mkdir(parents=True,exist_ok=True)
meta=get('ptbxl_database.csv')
(out/'ptbxl_metadata.sha256').write_text(hashlib.sha256(meta).hexdigest()+'\n',encoding='utf-8')
rows=list(csv.DictReader(io.StringIO(meta.decode())))
chosen=[]
for code,title in [('NORM','正常记录'),('CRBBB','完全性右束支阻滞记录'),('LVH','左室肥大标签记录'),('IMI','下壁梗死标签记录')]:
    row=next(r for r in rows if ast.literal_eval(r['scp_codes']).get(code,0)>=100 and r['validated_by_human']=='True')
    prefix=row['filename_hr']; header=get(prefix+'.hea').decode(); raw=get(prefix+'.dat')
    (out/(row['ecg_id']+'.hea')).write_text(header,encoding='utf-8')
    lines=header.splitlines();first=lines[0].split();channels=int(first[1]);fs=float(first[2]);n=int(first[3])
    specs=[l.split() for l in lines[1:channels+1]]
    assert all(s[1]=='16' for s in specs), 'Only WFDB format 16 supported'
    values=struct.unpack('<'+'h'*(len(raw)//2),raw)
    names=[s[-1] for s in specs];gains=[float(s[2].split('/')[0].split('(')[0]) for s in specs];baselines=[int(s[4]) for s in specs]
    # Preserve first six seconds at 500 Hz; no filtering, normalization or inferred labels.
    data=[[round((values[i*channels+j]-baselines[j])/gains[j],5) for j in range(channels)] for i in range(min(n,int(fs*6))) ]
    record={'id':row['ecg_id'],'title':title,'code':code,'codes':ast.literal_eval(row['scp_codes']),'fs':fs,'leads':names,'samples':data,'source':BASE+prefix,'sha256':hashlib.sha256(raw).hexdigest(),'report':row['report'],'license':'CC BY 4.0','transform':'Kors regression; reconstructed VCG, not measured Frank leads'}
    (out/('ptbxl-'+row['ecg_id']+'.json')).write_text(json.dumps(record,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    chosen.append({k:record[k] for k in ['id','title','code','codes','fs','source','sha256','license']})
    print(code,row['ecg_id'],len(data),'samples')
(out/'index.json').write_text(json.dumps(chosen,ensure_ascii=False,indent=2),encoding='utf-8')
(out/'LICENSE-PTBXL.txt').write_bytes(get('LICENSE.txt'))

import sys
sys.path.insert(0,'api')
from backend.lens.furigana import strip_furigana_trees

def item(text,b,h): return {'text':text,'bounds_px':b,'height_raw':h,'box':{'rotation_deg':90},'spans':[]}
def para(text,b,h): return {'text':text,'bounds_px':b,'items':[item(text,b,h)]}

ruby=para('かな',[30,0,35,60],.01)
base=para('魔法',[10,0,25,60],.02)
peer=para('火炎',[50,0,65,60],.02)
translated={'paragraphs':[para('อ่าน',[30,0,35,60],.01),para('เวทมนตร์',[10,0,25,60],.02),para('เปลวไฟ',[50,0,65,60],.02)]}
o,t,r=strip_furigana_trees({'paragraphs':[ruby,base,peer]},translated,source_lang='ja',img_h=1000)
assert [p['text'] for p in o['paragraphs']]==['魔法','火炎']
assert all(p.get('bounds_px') != [30,0,35,60] for p in o['paragraphs'])
assert t is translated  # Target paragraphs have independent segmentation.
assert r['paragraphsDropped']==1
# A real kana caption with ambiguous ownership is preserved rather than guessed away.
base2=para('属性',[12,0,27,60],.02)
o2,_,r2=strip_furigana_trees({'paragraphs':[ruby,base,base2]},translated,source_lang='ja',img_h=1000)
assert r2['paragraphsDropped']==0
assert o2['paragraphs'][0]['text']=='かな'
print('Furigana source removal PASS: text+geometry removed before grouping; ambiguous kana preserved.')

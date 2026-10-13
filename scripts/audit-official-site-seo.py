#!/usr/bin/env python3
"""Bounded public HTTP audit. Does not access Google's private index data."""
import concurrent.futures, datetime, hashlib, json, os, pathlib, urllib.request, urllib.error
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

OUT = pathlib.Path("evidence/seo")
OUT.mkdir(parents=True, exist_ok=True)
MAX_BODY = 2_000_000
class Metadata(HTMLParser):
    def __init__(self):
        super().__init__(); self.canonical=[]; self.robots=[]; self.title=[]; self.in_title=False
    def handle_starttag(self, tag, attrs):
        a=dict(attrs)
        if tag == "link" and "canonical" in a.get("rel","").lower().split(): self.canonical.append(a.get("href",""))
        if tag == "meta" and a.get("name","").lower() in ("robots","googlebot"): self.robots.append({"name":a["name"],"content":a.get("content","")})
        if tag == "title": self.in_title=True
    def handle_endtag(self, tag):
        if tag == "title": self.in_title=False
    def handle_data(self, data):
        if self.in_title: self.title.append(data)
class Redirects(urllib.request.HTTPRedirectHandler):
    def __init__(self): self.chain=[]
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.chain.append({"url":req.full_url,"status":code,"location":newurl})
        if urlsplit(newurl).hostname not in ("ombhrum.com","web.ombhrum.com","www.ombhrum.com","fabushi.ombhrum.com"): raise ValueError("Unexpected redirect host")
        return super().redirect_request(req, fp, code, msg, headers, newurl)
def read(url):
    redirects=Redirects(); row={"url":url,"redirects":redirects.chain}
    try:
        opener=urllib.request.build_opener(redirects)
        try: response=opener.open(urllib.request.Request(url,headers={"User-Agent":"Fabushi-Public-SEO-Audit/1.0"}),timeout=20)
        except urllib.error.HTTPError as error: response=error
        raw=response.read(MAX_BODY+1)
        if len(raw)>MAX_BODY: raise ValueError("Body limit exceeded")
        body=raw.decode("utf-8",errors="replace")
        row.update(status=response.code,final_url=response.url,headers={k.lower():v for k,v in response.headers.items() if k.lower() in ("content-type","location","link","x-robots-tag","cache-control","etag","cf-cache-status")},body_sha256=hashlib.sha256(raw).hexdigest())
        if "text/html" in response.headers.get("Content-Type",""):
            meta=Metadata(); meta.feed(body)
            row.update(canonical=[urljoin(response.url,x) for x in meta.canonical],robots=meta.robots,title="".join(meta.title))
        if url.endswith("/robots.txt"): row["robots_txt"]=body
        if url.endswith("/sitemap.xml"):
            root=ET.fromstring(body); row["sitemap_urls"]=[x.text for x in root.iter() if x.tag.endswith("}loc") or x.tag=="loc"]
            row["sitemap_type"]=root.tag.rsplit("}",1)[-1]
    except Exception as error: row["error"]=str(error)
    return row
urls=[
"https://ombhrum.com/","https://ombhrum.com/index.html","http://ombhrum.com/",
"https://www.ombhrum.com/","https://fabushi.ombhrum.com/",
"https://ombhrum.com/apps/","https://ombhrum.com/download/","https://ombhrum.com/faq/",
"https://ombhrum.com/privacy/","https://ombhrum.com/contact/","https://ombhrum.com/app/",
"https://ombhrum.com/robots.txt","https://ombhrum.com/sitemap.xml",
"https://web.ombhrum.com/","https://web.ombhrum.com/web/",
"https://web.ombhrum.com/robots.txt","https://web.ombhrum.com/sitemap.xml"]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool: rows=list(pool.map(read,urls))
sitemap=next(r for r in rows if r["url"]=="https://ombhrum.com/sitemap.xml")
sample=[]
if sitemap.get("sitemap_type")=="urlset":
    sample=[u for u in sitemap.get("sitemap_urls",[]) if urlsplit(u).hostname=="ombhrum.com" and not urlsplit(u).path.split("/")[-1].count(".") and u not in urls][:40]
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool: rows.extend(pool.map(read,sample))
violations=[]
for row in rows:
    u=row["url"]
    if u in urls[:1]+urls[5:11] or u in sample:
        if row.get("status")!=200 or row.get("canonical")!=[u]: violations.append({"url":u,"reason":"Expected HTTP 200 and page-specific canonical","actual":row})
web=next(r for r in rows if r["url"]=="https://web.ombhrum.com/")
if web.get("status")!=200 or web.get("canonical")!=["https://web.ombhrum.com/"]:
    violations.append({"url":web["url"],"reason":"Web root must be the independent application, with Web canonical"})
if not any("noindex" in m["content"] for m in web.get("robots",[])):
    violations.append({"url":web["url"],"reason":"Expected existing Web application noindex policy"})
for alias,expected in [
("https://ombhrum.com/index.html","https://ombhrum.com/"),
("http://ombhrum.com/","https://ombhrum.com/"),
("https://www.ombhrum.com/","https://ombhrum.com/"),
("https://fabushi.ombhrum.com/","https://ombhrum.com/"),
("https://web.ombhrum.com/web/","https://web.ombhrum.com/")]:
    row=next(r for r in rows if r["url"]==alias)
    if row.get("final_url")!=expected or not row["redirects"] or row["redirects"][0]["status"] not in (301,308):
        violations.append({"url":alias,"reason":"Expected permanent redirect","expected":expected})
for u in ["https://ombhrum.com/robots.txt","https://ombhrum.com/sitemap.xml"]:
    row=next(r for r in rows if r["url"]==u)
    if row.get("status")!=200: violations.append({"url":u,"reason":"Crawl metadata unavailable"})
report={"observed_at":datetime.datetime.now(datetime.timezone.utc).isoformat(),"source_sha":os.getenv("GITHUB_SHA"),"google_affected_urls":None,"google_selected_canonical":None,"sitemap_sample_limit":40,"pages":rows,"violations":violations}
(OUT/"http-audit.json").write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps({"source_sha":report["source_sha"],"pages":len(rows),"violations":len(violations),"google_index_data":"unavailable"},indent=2))
raise SystemExit(1 if violations else 0)

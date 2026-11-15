import base64
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from http.server import ThreadingHTTPServer
from research_workbench.launcher import App, Handler, Project

# A complete, small PDF with readable text, usable as a browser test fixture.
def sample_pdf():
    stream=b'BT /F1 20 Tf 60 720 Td (Research Workbench test document) Tj 0 -40 Td (Highlight this sentence and add a comment.) Tj ET'
    objs=[b'<< /Type /Catalog /Pages 2 0 R >>',b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',b'<< /Length '+str(len(stream)).encode()+b' >>\nstream\n'+stream+b'\nendstream']
    out=b'%PDF-1.4\n'; offsets=[0]
    for n,obj in enumerate(objs,1):
        offsets.append(len(out));out+=str(n).encode()+b' 0 obj\n'+obj+b'\nendobj\n'
    start=len(out);out+=b'xref\n0 6\n0000000000 65535 f \n'
    for offset in offsets[1:]:out+=f'{offset:010d} 00000 n \n'.encode()
    return out+b'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+str(start).encode()+b'\n%%EOF\n'

class EditorTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.folder=Path(self.temp.name)/'project'
        self.app=App(Path(self.temp.name)/'settings.json')
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.server.app=self.app
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.key,self.project=self.app.choose(str(self.folder))
        self.base='/api/projects/'+self.key+'/documents'
    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.temp.cleanup()
    def request(self,method,path,data=None,headers=None,token=True):
        h={'X-PDF-Token':self.app.token} if token else {}
        h.update(headers or {})
        if isinstance(data,dict): data=json.dumps(data)
        con=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=3)
        con.request(method,path,body=data,headers=h)
        res=con.getresponse();body=res.read();code=res.status;con.close();return code,body
    def upload(self,name='sample.pdf'):
        code,body=self.request('POST',self.base,{'name':name,'data':base64.b64encode(sample_pdf()).decode()});self.assertEqual(code,201,body);return json.loads(body)
    def test_roundtrip(self):
        d=self.upload();url=self.base+'/'+d['id']
        ann={'version':1,'highlights':[{'id':'h','page':1,'text':'test','color':'yellow','rects':[{'p':1,'x':60,'y':50,'w':100,'h':20}],'comments':[{'id':'c','text':'A comment'}]}],'strokes':[{'id':'s','page':1,'color':'#1971c2','width':2,'points':[[10,10],[20,20]]}]}
        self.assertEqual(self.request('PUT',url+'/annotations',ann)[0],200)
        self.assertEqual(self.request('PUT',url+'/annotated',sample_pdf())[0],200)
        reopened=Project(self.folder);stored=reopened.doc(d['id'])
        self.assertEqual(reopened.annotations(stored),ann)
        self.assertEqual(reopened.path(stored,'original').read_bytes(),sample_pdf())
        self.assertEqual(reopened.path(stored,'annotated').read_bytes(),sample_pdf())
        self.assertTrue(stored['exported']);self.assertFalse(stored['export_stale'])
        self.assertEqual(self.request('GET',url+'/original')[1],sample_pdf())
        self.assertEqual(self.request('GET',url+'/annotated')[1],sample_pdf())
        self.request('PUT',url+'/annotations',ann);self.assertTrue(stored['exported'])
        self.assertTrue(Project(self.folder).doc(d['id'])['export_stale'])
    def test_duplicates_and_existing_files(self):
        (self.folder/'originals'/'sample.pdf').write_bytes(b'preserve me')
        a=self.upload()
        code,body=self.request('POST',self.base,{'name':'sample.pdf','data':base64.b64encode(sample_pdf()).decode(),'separate':True})
        self.assertEqual(code,201);b=json.loads(body)
        self.assertEqual(a['name'],'sample.pdf');self.assertEqual(b['name'],'sample.pdf')
        self.assertNotEqual(self.project.path(a,'original'),self.project.path(b,'original'))
        self.assertEqual((self.folder/'originals'/'sample.pdf').read_bytes(),b'preserve me')
    def test_folder_isolation(self):
        a=self.upload();key,other=self.app.choose(str(Path(self.temp.name)/'other'))
        self.assertEqual(other.index['documents'],[])
        self.assertEqual(self.request('GET',f'/api/projects/{key}/documents/{a["id"]}/original')[0],404)
        self.assertEqual(self.request('GET',self.base+'/'+a['id']+'/original')[0],200)
    def test_bad_pdf(self):
        self.assertEqual(self.request('POST',self.base,{'name':'bad.pdf','data':base64.b64encode(b'bad').decode()})[0],400)
        self.assertEqual(self.project.index['documents'],[])
    def test_invalid_annotation_preserves_previous(self):
        d=self.upload();url=self.base+'/'+d['id']+'/annotations'
        before=self.request('GET',url)[1]
        self.assertEqual(self.request('PUT',url,{'highlights':'bad','strokes':[]})[0],400)
        self.assertEqual(self.request('GET',url)[1],before)
    def test_originals_cannot_be_written(self):
        d=self.upload();self.assertEqual(self.request('PUT',self.base+'/'+d['id']+'/original',sample_pdf())[0],404)
    def test_foreign_origin_and_missing_token(self):
        self.assertEqual(self.request('POST','/api/projects',{'folder':str(self.folder)},token=False)[0],403)
        self.assertEqual(self.request('POST','/api/projects',{},headers={'Origin':'https://foreign.example'})[0],403)
        self.assertEqual(self.request('GET','/api/config',headers={'Host':'foreign.example'})[0],403)
    def test_traversal_and_legacy_not_served(self):
        for path in ['/static/../research_workbench.py','/static/../../etc/passwd','/legacy/reviews/1320/review.json','/api/papers','/api/flow']:
            self.assertEqual(self.request('GET',path)[0],404,path)
    def test_symlink_guard(self):
        other=Path(self.temp.name)/'unsafe';other.mkdir();(other/'originals').symlink_to(self.folder/'originals')
        with self.assertRaises(ValueError):Project(other)
    def test_last_folder_persists(self):
        self.assertEqual(App(self.app.settings).last_folder,str(self.folder.resolve()))
    def test_corrupt_library_preserved(self):
        self.project.index_path.write_text('{broken')
        with self.assertRaises(ValueError):Project(self.folder)
        self.assertEqual(self.project.index_path.read_text(),'{broken')
    def test_reload_picks_up_library_changed_on_disk(self):
        d=self.upload()
        reload='/api/projects/'+self.key+'/reload'
        # Another process (a second editor, a script) renames the paper and adds a folder.
        other=Project(self.folder);snapshot=other.index_snapshot();snapshot['documents'][0]['name']='renamed.pdf'
        snapshot['folders'].append({'id':'f'*32,'name':'Outside'});other.commit(snapshot)
        self.assertEqual(json.loads(self.request('GET',self.base)[1])[0]['name'],'sample.pdf')
        code,body=self.request('POST',reload,{})
        self.assertEqual(code,200,body);body=json.loads(body)
        self.assertEqual(body['documents'][0]['name'],'renamed.pdf');self.assertEqual(body['folders'][0]['name'],'Outside')
        self.assertEqual(json.loads(self.request('GET',self.base)[1])[0]['id'],d['id'])
        # A broken file on disk is reported and the loaded library stays in use.
        self.project.index_path.write_text('{broken')
        code,body=self.request('POST',reload,{})
        self.assertEqual(code,400,body);self.assertIn('not valid JSON',json.loads(body)['error'])
        self.assertEqual(json.loads(self.request('GET',self.base)[1])[0]['name'],'renamed.pdf')
        self.assertEqual(self.project.index_path.read_text(),'{broken')
    def test_filename_sanitized(self):
        d=self.upload('../../escape.pdf');self.assertEqual(d['file'],'escape.pdf')
        self.assertFalse((Path(self.temp.name)/'escape.pdf').exists())

    def test_delete_restore_preserves_files_and_annotations(self):
        d=self.upload();other=self.upload('keep.pdf');url=self.base+'/'+d['id']
        ann={'version':1,'highlights':[],'strokes':[{'id':'s','page':1,'color':'#1971c2','width':2,'points':[[10,10],[20,20]]}]}
        self.request('PUT',url+'/annotations',ann)
        self.request('PUT',url+'/annotated',sample_pdf())
        paths=[self.project.path(d,kind) for kind in ('original','annotations','annotated')]
        before=[p.read_bytes() for p in paths]
        self.assertEqual(self.request('DELETE',url)[0],200)
        self.assertEqual([x['id'] for x in json.loads(self.request('GET',self.base)[1])],[other['id']])
        deleted=json.loads(self.request('GET','/api/projects/'+self.key+'/deleted')[1])
        self.assertEqual([x['id'] for x in deleted],[d['id']])
        reopened=Project(self.folder)
        self.assertEqual([x['id'] for x in reopened.documents()],[other['id']])
        with self.assertRaises(FileNotFoundError):reopened.doc(d['id'])
        self.assertEqual([p.read_bytes() for p in paths],before)
        self.assertEqual(self.request('POST',url+'/restore')[0],200)
        self.assertEqual(json.loads(self.request('GET',url+'/annotations')[1]),ann)
        self.assertEqual(Project(self.folder).documents(deleted=True),[])
        self.assertEqual([p.read_bytes() for p in paths],before)

    def test_deleted_document_rejects_stale_reads_and_writes(self):
        d=self.upload();url=self.base+'/'+d['id'];self.request('DELETE',url)
        for suffix in ('original','annotations','annotated'):
            self.assertEqual(self.request('GET',url+'/'+suffix)[0],404)
        self.assertEqual(self.request('PUT',url+'/annotations',{'highlights':[],'strokes':[]})[0],404)
        self.assertEqual(self.request('PUT',url+'/annotated',sample_pdf())[0],404)
        self.assertEqual(self.request('DELETE',url)[0],404)

    def test_delete_restore_requires_authorized_local_request(self):
        d=self.upload();url=self.base+'/'+d['id']
        self.assertEqual(self.request('DELETE',url,token=False)[0],403)
        self.assertEqual(self.request('DELETE',url,headers={'Origin':'https://foreign.example'})[0],403)
        self.request('DELETE',url)
        self.assertEqual(self.request('POST',url+'/restore',token=False)[0],403)
        key,_=self.app.choose(str(Path(self.temp.name)/'other'))
        self.assertEqual(self.request('DELETE',f'/api/projects/{key}/documents/{d["id"]}')[0],404)
        self.assertEqual(self.request('POST',f'/api/projects/{key}/documents/{d["id"]}/restore')[0],404)

    def test_failed_deletion_keeps_document_listed(self):
        d=self.upload();url=self.base+'/'+d['id']
        with patch.object(self.project,'persist',side_effect=OSError('disk full')):
            self.assertEqual(self.request('DELETE',url)[0],500)
        self.assertEqual(self.project.doc(d['id'])['id'],d['id'])
        self.assertEqual(Project(self.folder).doc(d['id'])['id'],d['id'])

    def test_deleted_filename_stays_reserved(self):
        d=self.upload();self.request('DELETE',self.base+'/'+d['id'])
        other=self.upload()
        self.assertEqual(other['name'],'sample.pdf')
        self.assertNotEqual(self.project.path(d,'original'),self.project.path(other,'original'))
        self.assertEqual(self.request('POST',self.base+'/'+d['id']+'/restore')[0],200)
        self.assertEqual(len(self.project.documents()),2)

    def test_strikethrough_roundtrip(self):
        d=self.upload();url=self.base+'/'+d['id']+'/annotations'
        ann={'version':1,'highlights':[{'id':'strike','type':'strikethrough','page':1,'text':'remove these words','color':'yellow','rects':[{'p':1,'x':60,'y':50,'w':100,'h':20},{'p':1,'x':60,'y':80,'w':60,'h':20}],'comments':[{'id':'note','text':'Suggested deletion'}]}],'strokes':[]}
        self.assertEqual(self.request('PUT',url,ann)[0],200)
        self.assertEqual(json.loads(self.request('GET',url)[1]),ann)
        reopened=Project(self.folder)
        self.assertEqual(reopened.annotations(reopened.doc(d['id'])),ann)

    def test_replacement_comment_roundtrip(self):
        d=self.upload();url=self.base+'/'+d['id']+'/annotations'
        ann={'version':1,'highlights':[{'id':'replacement','type':'strikethrough','intent':'replace','page':1,'text':'old wording','color':'yellow','rects':[{'p':1,'x':60,'y':50,'w':100,'h':20}],'comments':[{'id':'note','text':'Replacement: new wording'}]}],'strokes':[]}
        self.assertEqual(self.request('PUT',url,ann)[0],200)
        reopened=Project(self.folder)
        self.assertEqual(reopened.annotations(reopened.doc(d['id'])),ann)

    def revision(self, previous, **extra):
        code,body=self.request('POST',self.base,{'name':previous['name'],'data':base64.b64encode(sample_pdf()).decode(),'version_of':previous['id'],**extra})
        self.assertEqual(code,201,body)
        return json.loads(body)

    def test_duplicate_requires_choice_without_writing(self):
        a=self.upload()
        before={str(p):p.read_bytes() for p in self.folder.rglob('*') if p.is_file()}
        code,body=self.request('POST',self.base,{'name':'SAMPLE.PDF','data':base64.b64encode(sample_pdf()).decode()})
        self.assertEqual(code,409)
        self.assertEqual(json.loads(body)['matches'][0]['id'],a['id'])
        self.assertEqual(before,{str(p):p.read_bytes() for p in self.folder.rglob('*') if p.is_file()})
        code,body=self.request('POST','/api/projects/'+self.key+'/import-check',{'name':'sample.pdf'})
        self.assertEqual(code,200);self.assertEqual(json.loads(body)[0]['id'],a['id'])

    def test_versions_preserve_pdf_export_and_comments_new_is_clean(self):
        a=self.upload();url=self.base+'/'+a['id']
        ann={'version':1,'highlights':[{'id':'h','text':'old words','rects':[{'p':1,'x':1,'y':2,'w':3,'h':4}],'comments':[{'text':'Keep this old comment'}]}],'strokes':[]}
        self.request('PUT',url+'/annotations',ann)
        self.request('PUT',url+'/annotated',sample_pdf())
        before={kind:self.project.path(a,kind).read_bytes() for kind in ('original','annotations','annotated')}
        changed_pdf=sample_pdf().replace(b'Research Workbench test document',b'PDF newest test document')
        b=self.revision(a,data=base64.b64encode(changed_pdf).decode());c=self.revision(b)
        self.assertEqual(self.project.path(b,'original').read_bytes(),changed_pdf)
        self.assertEqual(c['number'],3);self.assertEqual(c['paper_id'],a['paper_id'])
        self.assertEqual([d['id'] for d in json.loads(self.request('GET',self.base)[1])],[c['id']])
        versions=json.loads(self.request('GET',self.base+'/'+c['id']+'/versions')[1])
        self.assertEqual([d['number'] for d in versions],[3,2,1])
        self.assertEqual([d['active'] for d in versions],[True,False,False])
        self.assertEqual(json.loads(self.request('GET',self.base+'/'+c['id']+'/annotations')[1]),{'version':1,'highlights':[],'strokes':[]})
        self.assertEqual(self.request('GET',self.base+'/'+c['id']+'/annotated')[0],404)
        self.assertFalse(c['exported'])
        for kind,contents in before.items():self.assertEqual(self.project.path(a,kind).read_bytes(),contents)
        reopened=Project(self.folder)
        self.assertEqual(len(reopened.documents()),1)
        self.assertEqual(reopened.annotations(reopened.doc(a['id'])),ann)
        self.assertEqual(len(reopened.versions(reopened.doc(c['id']))),3)

    def test_archived_revision_rejects_edits_and_stale_import(self):
        a=self.upload();b=self.revision(a);url=self.base+'/'+a['id']
        before=self.project.path(a,'annotations').read_bytes()
        self.assertEqual(self.request('PUT',url+'/annotations',{'highlights':[],'strokes':[]})[0],409)
        self.assertEqual(self.request('PUT',url+'/annotated',sample_pdf())[0],409)
        self.assertEqual(self.request('POST',self.base,{'name':a['name'],'data':base64.b64encode(sample_pdf()).decode(),'version_of':a['id']})[0],409)
        self.assertEqual(self.project.path(a,'annotations').read_bytes(),before)
        self.assertEqual(self.project.documents()[0]['id'],b['id'])
        self.assertEqual(self.request('GET',url+'/original')[0],200)

    def test_folder_membership_follows_whole_history(self):
        url='/api/projects/'+self.key+'/folders'
        code,body=self.request('POST',url,{'name':'Literature'})
        self.assertEqual(code,201);folder=json.loads(body)
        a=self.upload();b=self.revision(a)
        self.assertEqual(self.request('PUT',self.base+'/'+b['id']+'/folder',{'folder_id':folder['id']})[0],200)
        c=self.revision(b)
        reopened=Project(self.folder)
        self.assertTrue(all(v['folder_id']==folder['id'] for v in reopened.versions(reopened.doc(c['id']))))
        self.assertEqual(json.loads(self.request('GET',url)[1]),[folder])
        self.assertEqual(self.request('PUT',self.base+'/'+c['id']+'/folder',{'folder_id':None})[0],200)
        self.assertTrue(all(v['folder_id'] is None for v in self.project.versions(self.project.doc(c['id']))))
        self.assertEqual(self.request('POST',url,{'name':' literature '})[0],400)
        self.assertEqual(self.request('POST',url,{'name':'   '})[0],400)
        self.assertEqual(self.request('PUT',self.base+'/'+c['id']+'/folder',{'folder_id':'bad'})[0],400)

    def test_import_into_folder_and_explicit_separate_papers(self):
        folder=self.project.create_folder('Group')
        a=self.project.import_pdf('paper.pdf',sample_pdf(),folder_id=folder['id'])
        b=self.project.import_pdf('paper.pdf',sample_pdf(),separate=True)
        self.assertEqual(a['folder_id'],folder['id']);self.assertIsNone(b['folder_id'])
        self.assertNotEqual(a['paper_id'],b['paper_id'])
        c=self.revision(a)
        self.assertEqual({d['id'] for d in self.project.documents()},{b['id'],c['id']})
        self.assertEqual(c['folder_id'],folder['id'])
        self.assertEqual(len(self.project.matches('PAPER.pdf')),2)

    def test_delete_restore_entire_version_history(self):
        a=self.upload();b=self.revision(a);url=self.base+'/'+b['id']
        before={str(p):p.read_bytes() for p in self.folder.rglob('*') if p.is_file() and p.name!='library.json'}
        self.assertEqual(self.request('DELETE',url)[0],200)
        self.assertEqual(self.project.documents(),[])
        self.assertEqual(len(self.project.documents(deleted=True)),1)
        self.assertEqual(self.request('GET',self.base+'/'+a['id']+'/original')[0],404)
        self.assertEqual(self.request('POST',url+'/restore')[0],200)
        self.assertEqual(len(self.project.documents()),1)
        self.assertEqual(len(self.project.versions(self.project.doc(a['id']))),2)
        self.assertEqual(before,{str(p):p.read_bytes() for p in self.folder.rglob('*') if p.is_file() and p.name!='library.json'})

    def test_failed_version_import_leaves_latest_and_bytes_unchanged(self):
        a=self.upload()
        before={str(p):p.read_bytes() for p in self.folder.rglob('*') if p.is_file()}
        with patch.object(self.project,'persist',side_effect=OSError('disk full')):
            self.assertEqual(self.request('POST',self.base,{'name':a['name'],'data':base64.b64encode(sample_pdf()).decode(),'version_of':a['id']})[0],500)
        self.assertEqual(before,{str(p):p.read_bytes() for p in self.folder.rglob('*') if p.is_file()})
        self.assertEqual(self.project.documents()[0]['id'],a['id'])
        self.assertEqual(len(list(self.project.versions_root.iterdir())),1)
        self.assertTrue(Project(self.folder).doc(a['id'])['active'])

    def test_failed_folder_move_and_creation_roll_back(self):
        a=self.upload();folder=self.project.create_folder('Group')
        with patch.object(self.project,'persist',side_effect=OSError('disk full')):
            with self.assertRaises(OSError):self.project.move(a,folder['id'])
            with self.assertRaises(OSError):self.project.create_folder('Lost')
        self.assertIsNone(self.project.doc(a['id'])['folder_id'])
        self.assertEqual(self.project.index['folders'],[folder])

    def test_v1_migration_keeps_existing_files_and_separate_numbered_copies(self):
        import uuid
        docs=[]
        for name in ('paper.pdf','paper (6).pdf'):
            d={'id':uuid.uuid4().hex,'name':'paper.pdf','file':name,'updated':123,'exported':True,'export_stale':False}
            docs.append(d)
            (self.project.originals/name).write_bytes(sample_pdf())
            (self.project.annotated/name).write_bytes(sample_pdf())
            (self.project.meta/(d['id']+'.json')).write_text('{"version":1,"highlights":[],"strokes":[]}')
        self.project.index_path.write_text(json.dumps({'version':1,'documents':docs}))
        previous=self.project.index_path.read_bytes()
        before={str(p):p.read_bytes() for p in self.folder.rglob('*') if p.is_file() and p.name!='library.json'}
        migrated=Project(self.folder)
        self.assertEqual(len(migrated.documents()),2)
        self.assertEqual(migrated.index['version'],2)
        self.assertEqual(next(migrated.meta.glob('library-v1-backup-*.json')).read_bytes(),previous)
        for path,data in before.items():self.assertEqual(Path(path).read_bytes(),data)
        old=migrated.doc(docs[0]['id'])
        newest=migrated.import_pdf('paper.pdf',sample_pdf(),version_of=old['id'])
        self.assertEqual(newest['number'],2)
        self.assertEqual(len(migrated.documents()),2)
        self.assertEqual(migrated.path(old,'original').read_bytes(),sample_pdf())
        self.assertEqual(len(list(Project(self.folder).meta.glob('library-v1-backup-*.json'))),1)

    def test_version_and_folder_routes_require_authorization(self):
        a=self.upload()
        for path,data in [('/api/projects/'+self.key+'/folders',{'name':'Group'}),(self.base,{'name':a['name'],'data':base64.b64encode(sample_pdf()).decode(),'version_of':a['id']})]:
            self.assertEqual(self.request('POST',path,data,token=False)[0],403)
        self.assertEqual(self.request('PUT',self.base+'/'+a['id']+'/folder',{'folder_id':None},token=False)[0],403)
        self.assertEqual(self.request('POST',self.base,{'name':'different.pdf','data':base64.b64encode(sample_pdf()).decode(),'version_of':a['id']})[0],400)

    def test_failed_import_does_not_remove_existing_annotation_file(self):
        from types import SimpleNamespace
        key='a'*32
        existing=self.project.meta/(key+'.json')
        existing.write_bytes(b'preserve existing notes')
        with patch('research_workbench.launcher.uuid.uuid4',return_value=SimpleNamespace(hex=key)):
            with self.assertRaises(FileExistsError):self.project.import_pdf('new.pdf',sample_pdf())
        self.assertEqual(existing.read_bytes(),b'preserve existing notes')
        self.assertFalse((self.project.versions_root/key).exists())
        self.assertEqual(self.project.documents(),[])

    def test_stalled_pdf_download_does_not_block_library(self):
        d=self.upload();url=self.base+'/'+d['id']+'/original'
        started=threading.Event();release=threading.Event()
        send=Handler.send
        def paused_send(handler,*args,**kwargs):
            if handler.path==url:
                started.set();release.wait(10)
            return send(handler,*args,**kwargs)
        results=[]
        def download():
            try:results.append(self.request('GET',url)[0])
            except TimeoutError:pass
        with patch.object(Handler,'send',paused_send):
            client=threading.Thread(target=download);client.start()
            try:
                self.assertTrue(started.wait(2))
                self.assertEqual(self.request('GET',self.base)[0],200)
                self.assertEqual(self.request('POST','/api/projects',{'folder':str(self.folder)})[0],200)
            finally:
                release.set();client.join(5)
        self.assertEqual(results,[200])

if __name__=='__main__':unittest.main()

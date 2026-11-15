/** Adopt a synthetic response through the production source owner's construction seam.
 * @param {Workspace} owner Public buffer accessor. @param {string} file Fixture identity.
 * @param {object} fixture Native adapter dependency plus accepted text/revision.
 * @pre Caller owns the injected native test document; no private production state is read.
 * @post One public buffer is registered with the real ownership/revision implementation.
 * @return {SourceBuffer} Public buffer handle. @throws {Error} Invalid/duplicate fixture.
 */
export function adoptBuffer(owner,file,{doc,text,saved,sha='fixture'}={}) {
  const snapshot={file,text:text??saved??doc?.getValue()??'',sha};
  return owner.getSourceBuffers().adopt(snapshot,doc?{createDocument:()=>doc}:{});
}

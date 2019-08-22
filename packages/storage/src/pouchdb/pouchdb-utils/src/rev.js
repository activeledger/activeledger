import crypto from 'crypto';
import uuid from './uuid4';
import clone from './clone';

function stringMd5(string) {
  return crypto.createHash('md5').update(string, 'binary').digest('hex');
}

function rev(doc, deterministic_revs) {
  var clonedDoc = clone(doc);
  if (!deterministic_revs) {
    return uuid().replace(/-/g, '').toLowerCase();
  }

  delete clonedDoc._rev_tree;
  return stringMd5(JSON.stringify(clonedDoc));
}

export default rev;

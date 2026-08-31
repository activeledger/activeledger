import { Transform } from "stream";
import { StringDecoder } from "string_decoder";

export function newLineTransform() {
  const decoder = new StringDecoder("utf8");
  let _last: any;
  return new Transform({
    transform(chunk, encoding, cb) {
      if (_last === undefined) {
        _last = "";
      }
      _last += decoder.write(chunk);
      // Plain string split - behaviorally identical to /\n/ for a
      // single-char literal separator, without invoking the regex engine.
      // Runs per chunk on the backup/restore streaming path.
      var list = _last.split("\n");
      _last = list.pop();
      for (var i = 0; i < list.length; i++) {
        this.push(list[i]);
      }
      cb();
    },

    flush(cb) {
      _last += decoder.end();
      if (_last) {
        this.push(_last);
      }
      cb();
    },
  });
}

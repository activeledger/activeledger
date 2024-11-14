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
      var list = _last.split(/\n/);
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

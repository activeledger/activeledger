import { ActiveDSConnect, ActiveDSChanges } from "./dsconnect";

let ds = new ActiveDSConnect("http://localhost:5259/test");

let changes = ds.changes({
  since: "now",
  live: true,
  include_docs: true,
  timeout: false
}) as ActiveDSChanges;

changes.on("change", (r: any) => {
  console.log(r);
});


changes.on("error", (r: any) => {
    console.log("ERRROR");
    console.log(r);
  });
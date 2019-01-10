import { KeyPair } from "./keypair";

let a = {
  pub: {
    pkcs8pem:
      "-----BEGIN PUBLIC KEY-----\nMFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAEmLZwQKyuxfCk3p9LN2QOEpIJZEr3vl9s\nnA/bXTwE8NGO+hareV1ZiP2p/7Aih815rsLDjgPkhzZVwPPdWEgltg==\n-----END PUBLIC KEY-----",
    hash: "21d99ba13230c1d5a203bcbe824a81c43dd1391faf8d0772a85b28bab50901c4"
  },
  prv: {
    pkcs8pem:
      "-----BEGIN EC PRIVATE KEY-----\nMC4CAQEEIFsjd2Iw+Vo2WQ0fCVmdKihA1CbJf7eYpUB4nsYW7s9RoAcGBSuBBAAK\n-----END EC PRIVATE KEY-----",
    hash: "3368a6a3e4c6ed0bce9f82c061698294dc5deb4a32d19f4624d0911fdeec937e"
  }
};

// comptiable mode
let b = {
  pub: {
    pkcs8pem:
      "-----BEGIN PUBLIC KEY-----\nMFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAEzuoSh43BZWQMtG48LJMkulLiQnnY5P/u\nD5kW4Y9gfqY4rKqBtOvrmFdpBTk3NpIEueXWybukVQVBT+hdU2wx/Q==\n-----END PUBLIC KEY-----"
  },
  prv: {
    pkcs8pem:
      "-----BEGIN EC PRIVATE KEY-----\nMIGNAgEAMBAGByqGSM49AgEGBSuBBAAKBHYwdAIBAQQg2l5r+y59+pLujwaotwg3\nf2OQfe9jZLmLzbZEnEM/GJKgBwYFK4EEAAqhRANCAATO6hKHjcFlZAy0bjwskyS6\nUuJCedjk/+4PmRbhj2B+pjisqoG06+uYV2kFOTc2kgS55dbJu6RVBUFP6F1TbDH9\n-----END EC PRIVATE KEY-----"
  }
};

let ecPrv = new KeyPair("secp256k1", a.prv.pkcs8pem);
let ecPub = new KeyPair("secp256k1", a.pub.pkcs8pem);

//let rsa = new KeyPair("rsa");

// console.log(rsa.generate());

// console.log("Signature:")
// console.log(rsa.sign("rergjmerogjergijeg"));

console.log("=------------------------------------------");

//console.log(ec.generate());

console.log("Signature:");
let sig = ecPrv.sign("rergjmerogjergijeg");
console.log(sig);
console.log();

console.log("VERIFIEDD : ");
console.log(ecPub.verify("rergjmerogjergijeg", sig));

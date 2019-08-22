/*
 * MIT License (MIT)
 * Copyright (c) 2018 Activeledger
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { ActiveCrypto } from "@activeledger/activecrypto";
import { ActiveNetwork } from "@activeledger/activenetwork";
import { IActiveHttpIncoming } from "@activeledger/httpd";
import { ActiveledgerDatasource } from "./../datasource";

/**
 * Get this host secured context
 *
 * @returns {ActiveCrypto.Secured}
 */
function getSecuredContext(): ActiveCrypto.Secured {
  return new ActiveCrypto.Secured(
    ActiveledgerDatasource.getDb(),
    ActiveledgerDatasource.getNeighbourhood(),
    {
      reference: ActiveNetwork.Home.reference,
      public: Buffer.from(ActiveNetwork.Home.publicPem, "base64").toString(
        "utf8"
      ),
      private: ActiveNetwork.Home.identity.pem
    }
  );
}

/**
 * Attempts to Encrypt data follow ADAR rules
 *
 * @export
 * @param {IActiveHttpIncoming} incoming
 * @returns {Promise<object>}
 */
export async function encrypt(incoming: IActiveHttpIncoming): Promise<object> {
  return getSecuredContext().encrypt(incoming.body);
}

/**
 * * Attempts to Encrypt data follow ADAR & ADENC rules
 *
 * @export
 * @param {IActiveHttpIncoming} incoming
 * @returns {Promise<object>}
 */
export async function decrypt(incoming: IActiveHttpIncoming): Promise<object> {
  return getSecuredContext().decrypt(incoming.body);
}

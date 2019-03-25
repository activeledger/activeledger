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

//@ts-ignore
import * as pdfkit from "./pdfkit.js";
import { EventEmitter } from "events";

/**
 * Activeledger PDF Toolkit
 *
 * @export
 * @class PDF
 * @extends {EventEmitter}
 */
export class PDF extends EventEmitter {
  /**
   * PDFKit Object
   *
   * @type {PDFKit.PDFDocument}
   * @memberof PDF
   */
  public document: PDFKit.PDFDocument;

  /**
   * Output Buffers
   *
   * @private
   * @type {Buffer[]}
   * @memberof PDF
   */
  private buffers: Buffer[] = [];

  /**
   * Finalised Document
   *
   * @private
   * @type {Buffer}
   * @memberof PDF
   */
  private data: Buffer;

  /**
   *Creates an instance of PDF.
   * @memberof PDF
   */
  constructor() {
    super();
    // Create Document Object
    this.document = new pdfkit();

    // Listen on data out to build buffers
    this.document.on("data", this.buffers.push.bind(this.buffers));

    // Finalise buffer event
    this.document.on("end", () => {
      this.data = Buffer.concat(this.buffers);
      // emit own ready event
      this.emit("ready");
    });
  }

  /**
   * Get PDF Document as string encoding
   *
   * @param {string} [encoding="base64"]
   * @returns {Promise<string>}
   * @memberof PDF
   */
  public getData(encoding = "base64"): Promise<string> {
    return new Promise((resolve, reject) => {
      this.getDataBuffer()
        .then(buffer => {
          resolve(buffer.toString(encoding));
        })
        .catch(reject);
    });
  }

  /**
   * Get PDF document in Data URI Format
   *
   * @returns {Promise<string>}
   * @memberof PDF
   */
  public getDataURI(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.getData()
        .then(data => {
          resolve("data:application/pdf;base64," + data);
        })
        .catch(reject);
    });
  }

  /**
   * Get PDF Document as Buffer
   *
   * @returns {Promise<Buffer>}
   * @memberof PDF
   */
  public getDataBuffer(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      // Make sure the document has been finalised
      if (!this.data) {
        this.on("ready", () => {
          resolve(this.data);
        });
        this.document.end();
      } else {
        resolve(this.data);
      }
    });
  }
}

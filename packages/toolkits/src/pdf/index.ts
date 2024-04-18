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
import pdfmake from "./external/pdfmake.js";
import { TDocumentDefinitions, PDFKit } from "./interfaces";

/**
 * Activeledger PDF Toolkit
 *
 * @export
 * @class PDF
 * @extends {EventEmitter}
 */
export class PDF {
  /**
   * PDFKit Object
   *
   * @type {PDFKit.PDFDocument}
   */
  public document: PDFKit.PDFDocument;

  /**
   * Output Buffers
   *
   * @private
   * @type {Buffer[]}
   */
  private buffers: Buffer[] = [];

  /**
   * Finalised Document
   *
   * @private
   * @type {Buffer}
   */
  private data: Buffer;

  private printer: any;

  /**
   *Creates an instance of PDF.
   */
  constructor() {
    // Get PdfMake Printer
    this.printer = new (pdfmake as any)({
      Courier: {
        normal: "Courier",
        bold: "Courier-Bold",
        italics: "Courier-Oblique",
        bolditalics: "Courier-BoldOblique"
      },
      Helvetica: {
        normal: "Helvetica",
        bold: "Helvetica-Bold",
        italics: "Helvetica-Oblique",
        bolditalics: "Helvetica-BoldOblique"
      },
      Times: {
        normal: "Times-Roman",
        bold: "Times-Bold",
        italics: "Times-Italic",
        bolditalics: "Times-BoldItalic"
      },
      Symbol: {
        normal: "Symbol"
      },
      ZapfDingbats: {
        normal: "ZapfDingbats"
      }
    });




  }

  public async write(pdfMake: TDocumentDefinitions): Promise<boolean> {

    // Make sure the font is one of the supported
    const supportedFonts = [
      "Courier",
      "Helvetica",
      "Times",
      "Symbol",
      "ZapfDingbats"
    ];
    if (
      !pdfMake.defaultStyle ||
      !pdfMake.defaultStyle.font ||
      supportedFonts.indexOf(pdfMake.defaultStyle.font) !== -1
    ) {
      pdfMake.defaultStyle = {
        font: "Helvetica"
      };
    }

    // Create Document Object from PdfMake Definitions
    this.document = await this.printer.createPdfKitDocument(pdfMake);

    // Listen on data out to build buffers
    this.document.on("data", ui8a => {
      if (ui8a) {
        this.buffers.push(Buffer.from(ui8a));
      }
    });

    // Finalise buffer event
    this.document.on("end", () => {
      this.data = Buffer.concat(this.buffers);
    });

    return true;

  }

  /**
   * Get PDF Document as string encoding
   *
   * @param {string} [encoding="base64"]
   * @returns {Promise<string>}
   */
  public getData(encoding: BufferEncoding = "base64"): Promise<string> {
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
   */
  public getDataBuffer(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      // Make sure the document has been finalised
      if (!this.data) {
        this.document.end();
        // Move to back of the stack
        setTimeout(() => {
          resolve(this.data);
        }, 100);
      } else {
        resolve(this.data);
      }
    });
  }
}

export class Shared {
  /**
   * Maps streamId to their labels
   *
   * @private
   * @memberof Process
   */
  public ioLabelMap: any = { i: {}, o: {} };

  /**
   * Get the correct input for Label or key
   *
   * @private
   * @param {boolean} inputs
   * @param {string} streamId
   * @returns {string}
   * @memberof Process
   */
  public getLabelIOMap(inputs: boolean, streamId: string): string {
    // Get Correct Map
    let checkIOMap = inputs ? this.ioLabelMap.i : this.ioLabelMap.o;

    // If map empty default to key stream
    if (!Object.keys(checkIOMap).length) {
      return streamId;
    }
    return checkIOMap[streamId];
  }
}

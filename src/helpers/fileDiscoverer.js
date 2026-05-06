const XLSX = require('xlsx');
const { s3, bucketName } = require('../config/s3');

const fileDiscoverer = {
  /**
   * Downloads a file from S3 and extracts its schema (sheets and headers)
   * @param {string} s3Key - The S3 key of the file
   * @returns {Promise<Object>} - Schema object: { tableName: [columns] }
   */
  async discoverSchema(s3Key) {
    try {
      console.log(`[FILE_DISCOVERER] Fetching file from S3: ${s3Key}`);
      
      const params = {
        Bucket: bucketName,
        Key: s3Key
      };

      const data = await s3.getObject(params).promise();
      const buffer = data.Body;

      // Read the workbook from buffer
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const schema = {};

      // Iterate through each sheet
      workbook.SheetNames.forEach(sheetName => {
        const worksheet = workbook.Sheets[sheetName];
        
        // Convert to JSON to get headers (header: 1 means return rows as arrays)
        const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        
        if (jsonData.length > 0) {
          // The first row is the header row
          const headers = jsonData[0]
            .filter(cell => cell !== null && cell !== undefined)
            .map(cell => String(cell).trim())
            .filter(cell => cell !== '');
          
          if (headers.length > 0) {
            schema[sheetName] = headers;
          }
        }
      });

      return schema;
    } catch (error) {
      console.error('[FILE_DISCOVERER] Error discovering schema:', error);
      throw new Error(`Failed to extract schema from file: ${error.message}`);
    }
  }
};

module.exports = fileDiscoverer;

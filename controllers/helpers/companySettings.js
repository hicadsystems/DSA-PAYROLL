const fs = require('fs');
const pool = require('../../config/db');
const path = require('path');

class CompanySettingsHelper {
  constructor() {
    this.cachedSettings = null;
  }

  /**
   * Get company settings including logo
   * @param {Object} db - Database connection object
   * @returns {Promise<Object>} Company settings with logoDataUrl
   */
  async getSettings(db) {
    // Return cached if available
    if (this.cachedSettings) {
      return this.cachedSettings;
    }

    try {
      // Fetch from database
      const query = 'SELECT Id, comp_code, comp_name, company_image FROM py_paysystem WHERE Id = 1';
      const result = await pool.query(query);
      
      if (result && result.length > 0) {
        const settings = result[0];
        
        this.cachedSettings = {
          logoDataUrl: settings.logo ? `data:image/png;base64,${settings.logo}` : '',
          companyName: settings.company_name || 'Nigerian Navy (Naval Headquarters)',
          companyAddress: settings.address || 'CENTRAL PAY OFFICE, 23 POINT ROAD APAPA'
        };
      } else {
        // Fallback to defaults
        this.cachedSettings = this._getDefaults();
      }
      
      return this.cachedSettings;
    } catch (error) {
      console.error('Error fetching company settings:', error);
      return this._getDefaults();
    }
  }

  /**
   * Get settings from file system (fallback option)
   * Useful if you want to load from public/photos/logo.png
   */
async getSettingsFromFile(logoPath = './public/photos/logo.png') {
 if (this.cachedSettings) {
    return this.cachedSettings;
  }

  try {
    const absolutePath = path.resolve(logoPath);
    console.log('🔍 Looking for logo at:', absolutePath);
    
    if (fs.existsSync(absolutePath)) {
      console.log('✅ Logo file found!');
      
      const logoBuffer = fs.readFileSync(absolutePath);
      const logoBase64 = logoBuffer.toString('base64');
      
      // Detect image type from file extension
      const ext = path.extname(absolutePath).toLowerCase();
      let mimeType = 'image/png';
      if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
      if (ext === '.svg') mimeType = 'image/svg+xml';
      
      this.cachedSettings = {
        logoDataUrl: `data:${mimeType};base64,${logoBase64}`,
        companyName: 'Nigerian Navy (Naval Headquarters)',
        companyAddress: 'CENTRAL PAY OFFICE, 23 POINT ROAD APAPA'
      };
      
      console.log('✅ Settings created successfully');
      console.log('📊 logoDataUrl preview:', this.cachedSettings.logoDataUrl.substring(0, 100));
      
      return this.cachedSettings;
    } else {
      console.error('❌ Logo file NOT found at:', absolutePath);
      console.log('💡 Current directory:', process.cwd());
      console.log('💡 Try checking if the file exists at this exact path');
      return this._getDefaults();
    }
  } catch (error) {
    console.error('❌ Error loading logo from file:', error);
    return this._getDefaults();
  }
}

  /**
   * Clear cache - useful when logo is updated
   */
  clearCache() {
    this.cachedSettings = null;
  }

  /**
   * Default settings when logo can't be loaded
   */
  _getDefaults() {
    return {
      logoDataUrl: '',
      companyName: 'Nigerian Navy (Naval Headquarters)',
      companyAddress: 'CENTRAL PAY OFFICE, 23 POINT ROAD APAPA'
    };
  }
}

// Export singleton instance
module.exports = new CompanySettingsHelper();
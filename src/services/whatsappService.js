const axios = require('axios');

/**
 * Service to handle sending messages to WhatsApp via Twilio or Meta Cloud API.
 */
class WhatsappService {
    /**
     * Check if the config contains mock credentials to bypass live API calls
     */
    isMockConfig(config) {
        if (!config) return false;
        return (
            (config.twilio_account_sid && config.twilio_account_sid.includes('mock')) ||
            (config.meta_access_token && config.meta_access_token.includes('mock'))
        );
    }

    /**
     * Send a text message to a WhatsApp user
     * @param {string} to - Recipient phone number (e.g. "+1234567890")
     * @param {string} text - Message text (supports WhatsApp markdown)
     * @param {object} config - Integration config containing provider credentials
     */
    async sendText(to, text, config) {
        if (this.isMockConfig(config)) {
            console.log(`📡 [MOCK WHATSAPP TEXT DELIVERY] To: ${to}, Content:\n${text}`);
            return { sid: `SMmock_text_${Date.now()}`, status: 'queued' };
        }

        const provider = (config.provider || 'twilio').toLowerCase();
        
        if (provider === 'twilio') {
            return this.sendTwilioText(to, text, config);
        } else if (provider === 'meta') {
            return this.sendMetaText(to, text, config);
        } else {
            throw new Error(`Unsupported WhatsApp provider: ${provider}`);
        }
    }

    /**
     * Send a document/PDF attachment to a WhatsApp user
     * @param {string} to - Recipient phone number (e.g. "+1234567890")
     * @param {string} fileUrl - Public URL of the document
     * @param {string} fileName - Display file name of the document
     * @param {object} config - Integration config containing provider credentials
     */
    async sendDocument(to, fileUrl, fileName, config) {
        if (this.isMockConfig(config)) {
            console.log(`📡 [MOCK WHATSAPP DOCUMENT DELIVERY] To: ${to}, URL: ${fileUrl}, Filename: ${fileName}`);
            return { sid: `SMmock_doc_${Date.now()}`, status: 'queued' };
        }

        const provider = (config.provider || 'twilio').toLowerCase();
        
        if (provider === 'twilio') {
            return this.sendTwilioDocument(to, fileUrl, config);
        } else if (provider === 'meta') {
            return this.sendMetaDocument(to, fileUrl, fileName, config);
        } else {
            throw new Error(`Unsupported WhatsApp provider: ${provider}`);
        }
    }

    /**
     * Send an image attachment to a WhatsApp user (useful for graphs)
     * @param {string} to - Recipient phone number
     * @param {string} imageUrl - Public URL of the image
     * @param {object} config - Integration config containing provider credentials
     */
    async sendImage(to, imageUrl, config) {
        if (this.isMockConfig(config)) {
            console.log(`📡 [MOCK WHATSAPP IMAGE DELIVERY] To: ${to}, URL: ${imageUrl}`);
            return { sid: `SMmock_img_${Date.now()}`, status: 'queued' };
        }

        const provider = (config.provider || 'twilio').toLowerCase();
        
        if (provider === 'twilio') {
            return this.sendTwilioImage(to, imageUrl, config);
        } else if (provider === 'meta') {
            return this.sendMetaImage(to, imageUrl, config);
        } else {
            throw new Error(`Unsupported WhatsApp provider: ${provider}`);
        }
    }

    // --- TWILIO API IMPLEMENTATION ---

    async sendTwilioText(to, text, config) {
        const { twilio_account_sid, twilio_auth_token, phone_number } = config;
        
        if (!twilio_account_sid || !twilio_auth_token || !phone_number) {
            throw new Error('Missing Twilio credentials in integration config');
        }

        const url = `https://api.twilio.com/2010-04-01/Accounts/${twilio_account_sid}/Messages.json`;
        const auth = Buffer.from(`${twilio_account_sid}:${twilio_auth_token}`).toString('base64');
        
        const params = new URLSearchParams();
        params.append('From', `whatsapp:${phone_number}`);
        params.append('To', `whatsapp:${to}`);
        params.append('Body', text);

        console.log(`📤 Sending Twilio WhatsApp SMS to ${to} from ${phone_number}...`);
        
        const response = await axios.post(url, params, {
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        
        return response.data;
    }

    async sendTwilioDocument(to, fileUrl, config) {
        const { twilio_account_sid, twilio_auth_token, phone_number } = config;
        
        if (!twilio_account_sid || !twilio_auth_token || !phone_number) {
            throw new Error('Missing Twilio credentials in integration config');
        }

        const url = `https://api.twilio.com/2010-04-01/Accounts/${twilio_account_sid}/Messages.json`;
        const auth = Buffer.from(`${twilio_account_sid}:${twilio_auth_token}`).toString('base64');
        
        const params = new URLSearchParams();
        params.append('From', `whatsapp:${phone_number}`);
        params.append('To', `whatsapp:${to}`);
        params.append('MediaUrl', fileUrl);

        console.log(`📤 Sending Twilio WhatsApp PDF to ${to} from ${phone_number}. URL: ${fileUrl}`);

        const response = await axios.post(url, params, {
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        return response.data;
    }

    async sendTwilioImage(to, imageUrl, config) {
        // Twilio treats images and documents both via MediaUrl
        const { twilio_account_sid, twilio_auth_token, phone_number } = config;
        
        if (!twilio_account_sid || !twilio_auth_token || !phone_number) {
            throw new Error('Missing Twilio credentials in integration config');
        }

        const url = `https://api.twilio.com/2010-04-01/Accounts/${twilio_account_sid}/Messages.json`;
        const auth = Buffer.from(`${twilio_account_sid}:${twilio_auth_token}`).toString('base64');
        
        const params = new URLSearchParams();
        params.append('From', `whatsapp:${phone_number}`);
        params.append('To', `whatsapp:${to}`);
        params.append('MediaUrl', imageUrl);

        console.log(`📤 Sending Twilio WhatsApp Image to ${to} from ${phone_number}. URL: ${imageUrl}`);

        const response = await axios.post(url, params, {
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        return response.data;
    }

    // --- META CLOUD API IMPLEMENTATION ---

    async sendMetaText(to, text, config) {
        const { meta_phone_id, meta_access_token } = config;
        
        if (!meta_phone_id || !meta_access_token) {
            throw new Error('Missing Meta Cloud API credentials in integration config');
        }

        // Meta requires clean numeric recipient without lead '+' or whatsapp: prefix
        const cleanTo = to.replace(/[^0-9]/g, '');
        const url = `https://graph.facebook.com/v19.0/${meta_phone_id}/messages`;
        
        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanTo,
            type: 'text',
            text: {
                preview_url: false,
                body: text
            }
        };

        console.log(`📤 Sending Meta Cloud API WhatsApp message to ${cleanTo}...`);

        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${meta_access_token}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data;
    }

    async sendMetaDocument(to, fileUrl, fileName, config) {
        const { meta_phone_id, meta_access_token } = config;
        
        if (!meta_phone_id || !meta_access_token) {
            throw new Error('Missing Meta Cloud API credentials in integration config');
        }

        const cleanTo = to.replace(/[^0-9]/g, '');
        const url = `https://graph.facebook.com/v19.0/${meta_phone_id}/messages`;
        
        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanTo,
            type: 'document',
            document: {
                link: fileUrl,
                filename: fileName
            }
        };

        console.log(`📤 Sending Meta Cloud API WhatsApp PDF to ${cleanTo}. URL: ${fileUrl}`);

        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${meta_access_token}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data;
    }

    async sendMetaImage(to, imageUrl, config) {
        const { meta_phone_id, meta_access_token } = config;
        
        if (!meta_phone_id || !meta_access_token) {
            throw new Error('Missing Meta Cloud API credentials in integration config');
        }

        const cleanTo = to.replace(/[^0-9]/g, '');
        const url = `https://graph.facebook.com/v19.0/${meta_phone_id}/messages`;
        
        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanTo,
            type: 'image',
            image: {
                link: imageUrl
            }
        };

        console.log(`📤 Sending Meta Cloud API WhatsApp Image to ${cleanTo}. URL: ${imageUrl}`);

        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${meta_access_token}`,
                'Content-Type': 'application/json'
            }
        });

        return response.data;
    }
}

module.exports = new WhatsappService();

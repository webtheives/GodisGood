require('dotenv').config();

const fs = require('fs');
const express = require('express');
const multer = require('multer');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');
const { Resend } = require('resend');

const app = express();

// ==========================================
// 0. REQUIRED ENV VARS (fail fast if missing)
// ==========================================
const REQUIRED_ENV = ['RESEND_API_KEY', 'SESSION_SECRET', 'OWNER_EMAIL'];
for (const key of REQUIRED_ENV) {
    if (!process.env[key]) {
        console.error(`Missing required environment variable: ${key}`);
        process.exit(1);
    }
}

// Splits comma-separated emails into an array and trims extra whitespace
const OWNER_EMAILS = process.env.OWNER_EMAIL ? process.env.OWNER_EMAIL.split(',').map(e => e.trim()) : [];

// Active promo codes database (15% discount for SAVE15 or UNLOCK15)
const PROMO_CODES = {
    'SAVE15': 0.15,
    'UNLOCK15': 0.15
};

/**
 * Helper function to validate and compute price securely on backend 
 * using dynamically supplied base amount and currency.
 */
function calculateFinalPrice(rawAmount, currency = 'CAD', promoCode) {
    const basePrice = parseFloat(rawAmount) || 0.0;
    const safeCurrency = (currency || 'CAD').toUpperCase();
    let discountPercent = 0;

    if (promoCode && PROMO_CODES[promoCode.trim().toUpperCase()]) {
        discountPercent = PROMO_CODES[promoCode.trim().toUpperCase()];
    }

    const discountAmount = basePrice * discountPercent;
    const finalPrice = Math.max(0, basePrice - discountAmount);

    return {
        basePrice,
        currency: safeCurrency,
        discountAmount,
        finalPrice,
        discountPercent: discountPercent * 100,
        appliedCode: discountPercent > 0 ? promoCode.trim().toUpperCase() : null
    };
}

// Trust the first reverse proxy hop (Heroku/Render/nginx/etc.)
if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

// ==========================================
// 1. MIDDLEWARE
// ==========================================
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(express.json({ limit: '100kb' }));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 24 // 1 day
    }
}));

// Basic rate limiting applied to submission endpoints
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many attempts. Please try again later.' }
});

// Ensure the uploads directory exists
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Multer setup for manual proof attachments
const upload = multer({
    dest: UPLOAD_DIR,
    limits: { fileSize: 5 * 1024 * 1024, files: 3 },
    fileFilter: (req, file, cb) => {
        const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
        cb(null, allowed.includes(file.mimetype));
    }
});

// Escape HTML utility
function escapeHtml(str = '') {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Reusable Brand Email Wrapper Component
function renderEmailTemplate({ title, badge, badgeBg = '#d4a373', content }) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="margin: 0; padding: 0; background-color: #0f172a; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
        <table width="100%" cellspacing="0" cellpadding="0" style="background-color: #0f172a; padding: 40px 10px;">
            <tr>
                <td align="center">
                    <table width="600" cellspacing="0" cellpadding="0" style="background-color: #1e293b; color: #f8fafc; border-radius: 12px; overflow: hidden; border: 1px solid #334155; box-shadow: 0 10px 25px rgba(0,0,0,0.3);">
                        <tr>
                            <td style="padding: 32px 40px; background-color: #0f172a; border-bottom: 1px solid #334155; text-align: center;">
                                <h1 style="margin: 0; font-size: 20px; font-weight: 700; letter-spacing: 3px; color: #f8fafc; text-transform: uppercase;">
                                    Montrose Massage
                                </h1>
                                <p style="margin: 6px 0 0 0; font-size: 11px; color: #d4a373; letter-spacing: 1.5px; text-transform: uppercase;">Luxury In-Home Wellness</p>
                            </td>
                        </tr>
                        ${title ? `
                        <tr>
                            <td style="padding: 24px 40px; background-color: #1e293b; border-bottom: 1px solid #334155;">
                                ${badge ? `<span style="display: inline-block; background-color: ${badgeBg}; color: #0f172a; font-size: 10px; font-weight: 800; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; letter-spacing: 1px;">${badge}</span>` : ''}
                                <h2 style="margin: 10px 0 0 0; font-size: 18px; color: #f8fafc; font-weight: 600;">${title}</h2>
                            </td>
                        </tr>
                        ` : ''}
                        <tr>
                            <td style="padding: 32px 40px; font-size: 14px; color: #cbd5e1; line-height: 1.6;">
                                ${content}
                            </td>
                        </tr>
                        <tr>
                            <td style="padding: 24px 40px; background-color: #0f172a; text-align: center; color: #64748b; font-size: 12px; border-top: 1px solid #334155;">
                                <p style="margin: 0 0 6px 0; font-weight: 500;">Concierge In-Home Care</p>
                                <p style="margin: 0;">&copy; 2026 Montrose Massage. All rights reserved.</p>
                            </td>
                        </tr>
                    </table>
                </td>
            </tr>
        </table>
    </body>
    </html>
    `;
}

// ==========================================
// 2. RESEND EMAIL CLIENT SETUP
// ==========================================
const resend = new Resend(process.env.RESEND_API_KEY);

// ==========================================
// 3. BOOKING SUBMISSION HANDLER
// ==========================================
async function handleBookingSubmission(req, res) {
    try {
        const { serviceType, amount, currency, promoCode, date, timeSlot, fullName, email, phone, preferredTherapist, address } = req.body;
        const priceInfo = calculateFinalPrice(amount, currency, promoCode);
        const bookingId = 'MM-' + crypto.randomInt(100000, 999999);

        res.json({
            success: true,
            bookingId,
            basePrice: priceInfo.basePrice,
            currency: priceInfo.currency,
            discountAmount: priceInfo.discountAmount,
            amount: priceInfo.finalPrice,
            promoApplied: priceInfo.appliedCode
        });

        // Background email processing
        setImmediate(async () => {
            try {
                const clientEmail = email;
                const clientName = escapeHtml(fullName || 'Valued Client');
                const safeService = escapeHtml(serviceType || 'In-Home Massage');
                const safeTherapist = escapeHtml(preferredTherapist || 'Any Available Specialist');
                const safeDate = escapeHtml(date || 'To be selected');
                const safeTime = escapeHtml(timeSlot || 'Standard Slot');
                const safeAddress = escapeHtml(address || 'N/A');

                const promoRow = priceInfo.appliedCode ? `
                    <tr>
                        <td style="color: #94a3b8; border-bottom: 1px solid #1e293b;">Discount (${priceInfo.appliedCode}):</td>
                        <td style="color: #34d399; font-weight: 600; text-align: right; border-bottom: 1px solid #1e293b;">-${priceInfo.discountPercent}% (-${priceInfo.currency} $${priceInfo.discountAmount.toFixed(2)})</td>
                    </tr>
                ` : '';

                const detailsTable = `
                    <table width="100%" cellspacing="0" cellpadding="12" style="background-color: #0f172a; border: 1px solid #334155; margin: 20px 0; border-radius: 8px;">
                        <tr>
                            <td style="color: #94a3b8; border-bottom: 1px solid #1e293b;">Booking Reference:</td>
                            <td style="color: #d4a373; font-weight: 700; text-align: right; border-bottom: 1px solid #1e293b;">#${bookingId}</td>
                        </tr>
                        <tr>
                            <td style="color: #94a3b8; border-bottom: 1px solid #1e293b;">Selected Treatment:</td>
                            <td style="color: #f8fafc; font-weight: 600; text-align: right; border-bottom: 1px solid #1e293b;">${safeService}</td>
                        </tr>
                        <tr>
                            <td style="color: #94a3b8; border-bottom: 1px solid #1e293b;">Requested Therapist:</td>
                            <td style="color: #f8fafc; font-weight: 600; text-align: right; border-bottom: 1px solid #1e293b;">${safeTherapist}</td>
                        </tr>
                        <tr>
                            <td style="color: #94a3b8; border-bottom: 1px solid #1e293b;">Service Address:</td>
                            <td style="color: #f8fafc; font-weight: 600; text-align: right; border-bottom: 1px solid #1e293b;">${safeAddress}</td>
                        </tr>
                        <tr>
                            <td style="color: #94a3b8; border-bottom: 1px solid #1e293b;">Date & Time:</td>
                            <td style="color: #f8fafc; font-weight: 600; text-align: right; border-bottom: 1px solid #1e293b;">${safeDate} (${safeTime})</td>
                        </tr>
                        ${promoRow}
                        <tr>
                            <td style="color: #94a3b8;">Total Amount:</td>
                            <td style="color: #34d399; font-weight: 700; text-align: right;">${priceInfo.currency} $${priceInfo.finalPrice.toFixed(2)}</td>
                        </tr>
                    </table>
                `;

                if (clientEmail) {
                    await resend.emails.send({
                        from: 'Montrose Massage <Booking@montrosemassage.site>',
                        to: clientEmail,
                        subject: `Booking Request Received — Ref: #${bookingId}`,
                        html: renderEmailTemplate({
                            title: 'Booking Details Received',
                            badge: 'Pending Payment',
                            badgeBg: '#3b82f6',
                            content: `
                                <p style="margin-top: 0;">Dear <strong>${clientName}</strong>,</p>
                                <p>Thank you for booking an in-home session with <strong>Montrose Massage</strong>. We have temporarily reserved your appointment.</p>
                                ${detailsTable}
                                <p>Please complete payment to finalize your session lock-in and therapist dispatch.</p>
                            `
                        })
                    });
                }

                await resend.emails.send({
                    from: 'Montrose Massage <Booking@montrosemassage.site>',
                    to: OWNER_EMAILS,
                    subject: `[ADMIN ALERT] New Booking Request #${bookingId} — ${clientName}`,
                    html: renderEmailTemplate({
                        title: 'New Client Booking Submitted',
                        badge: 'Admin Notice',
                        badgeBg: '#f59e0b',
                        content: `
                            <p style="margin-top: 0;">A new booking has been recorded and is currently pending payment confirmation.</p>
                            <table width="100%" cellspacing="0" cellpadding="10" style="background-color: #0f172a; border: 1px solid #334155; margin: 15px 0; border-radius: 8px;">
                                <tr><td style="color: #94a3b8;">Client Name:</td><td style="color: #f8fafc; text-align: right;">${clientName}</td></tr>
                                <tr><td style="color: #94a3b8;">Client Email:</td><td style="color: #f8fafc; text-align: right;">${escapeHtml(clientEmail || 'N/A')}</td></tr>
                                <tr><td style="color: #94a3b8;">Client Phone:</td><td style="color: #f8fafc; text-align: right;">${escapeHtml(phone || 'N/A')}</td></tr>
                            </table>
                            ${detailsTable}
                        `
                    })
                });

            } catch (emailErr) {
                console.error('Background booking email error:', emailErr);
            }
        });

    } catch (err) {
        console.error('Booking route error:', err);
        res.status(500).json({ success: false, error: 'Server error processing booking.' });
    }
}

// ==========================================
// 4. PAYMENT & PROOF SUBMISSION HANDLER
// ==========================================
async function handlePaymentSubmission(req, res) {
    const uploadedFiles = req.files || [];
    try {
        const { paymentMethod, fullName, email, promoCode, amount, currency, bookingId: clientBookingId } = req.body;
        const priceInfo = calculateFinalPrice(amount, currency, promoCode);
        const bookingId = clientBookingId || ('MM-' + crypto.randomInt(100000, 999999));

        res.json({
            success: true,
            bookingId,
            amount: priceInfo.finalPrice,
            currency: priceInfo.currency
        });

        // Background Payment Notifications Dispatch
        setImmediate(async () => {
            try {
                const clientEmail = email;
                const clientName = escapeHtml(fullName || 'Valued Client');
                const safeMethod = escapeHtml(paymentMethod || 'Manual Transfer');
                const fileCount = uploadedFiles.length;

                const emailAttachments = uploadedFiles.map((file) => ({
                    filename: file.originalname || file.filename,
                    content: fs.readFileSync(file.path)
                }));

                const paymentTable = `
                    <table width="100%" cellspacing="0" cellpadding="12" style="background-color: #0f172a; border: 1px solid #334155; margin: 20px 0; border-radius: 8px;">
                        <tr>
                            <td style="color: #94a3b8; border-bottom: 1px solid #1e293b;">Reference ID:</td>
                            <td style="color: #d4a373; font-weight: 700; text-align: right; border-bottom: 1px solid #1e293b;">#${bookingId}</td>
                        </tr>
                        <tr>
                            <td style="color: #94a3b8; border-bottom: 1px solid #1e293b;">Payment Method:</td>
                            <td style="color: #f8fafc; font-weight: 600; text-align: right; border-bottom: 1px solid #1e293b;">${safeMethod}</td>
                        </tr>
                        <tr>
                            <td style="color: #94a3b8; border-bottom: 1px solid #1e293b;">Amount Paid:</td>
                            <td style="color: #34d399; font-weight: 700; text-align: right; border-bottom: 1px solid #1e293b;">${priceInfo.currency} $${priceInfo.finalPrice.toFixed(2)}</td>
                        </tr>
                        <tr>
                            <td style="color: #94a3b8;">Status:</td>
                            <td style="color: #f59e0b; font-weight: 700; text-align: right;">Under Finance Verification</td>
                        </tr>
                    </table>
                `;

                if (clientEmail) {
                    await resend.emails.send({
                        from: 'Montrose Massage <payment@montrosemassage.site>',
                        to: clientEmail,
                        subject: `Payment Receipt — Ref: #${bookingId}`,
                        html: renderEmailTemplate({
                            title: 'Payment Confirmation Received',
                            badge: 'Under Verification',
                            badgeBg: '#f59e0b',
                            content: `
                                <p style="margin-top: 0;">Dear <strong>${clientName}</strong>,</p>
                                <p>We have received your payment submission. Our finance team is currently validating the details.</p>
                                ${paymentTable}
                                <p>Once verified, your appointment details will be fully locked in.</p>
                            `
                        })
                    });
                }

                await resend.emails.send({
                    from: 'Montrose Massage <Booking@montrosemassage.site>',
                    to: OWNER_EMAILS,
                    subject: `[ADMIN ALERT] Payment Proof Submitted #${bookingId} — ${clientName}`,
                    attachments: emailAttachments,
                    html: renderEmailTemplate({
                        title: 'Payment Verification Required',
                        badge: 'Action Needed',
                        badgeBg: '#34d399',
                        content: `
                            <p style="margin-top: 0;">A client has submitted payment proof for verification.</p>
                            <table width="100%" cellspacing="0" cellpadding="10" style="background-color: #0f172a; border: 1px solid #334155; margin: 15px 0; border-radius: 8px;">
                                <tr><td style="color: #94a3b8;">Client Name:</td><td style="color: #f8fafc; text-align: right;">${clientName}</td></tr>
                                <tr><td style="color: #94a3b8;">Client Email:</td><td style="color: #f8fafc; text-align: right;">${escapeHtml(clientEmail || 'N/A')}</td></tr>
                                <tr><td style="color: #94a3b8;">Files Uploaded:</td><td style="color: #f8fafc; text-align: right;">${fileCount} Attachment(s)</td></tr>
                            </table>
                            ${paymentTable}
                        `
                    })
                });

            } catch (emailErr) {
                console.error('Background payment email error:', emailErr);
            } finally {
                // Safely clean up local upload files after emailing
                for (const file of uploadedFiles) {
                    fs.unlink(file.path, (err) => {
                        if (err) console.error('Error deleting upload file:', err);
                    });
                }
            }
        });

    } catch (err) {
        console.error('Payment processing error:', err);
        for (const file of uploadedFiles) {
            fs.unlink(file.path, (err) => {
                if (err) console.error('Error deleting upload file:', err);
            });
        }
        return res.status(500).json({ success: false, error: 'Internal server error processing payment.' });
    }
}

// ==========================================
// 5. API ROUTE FOR PROMO VALIDATION
// ==========================================
app.post('/api/validate-promo', apiLimiter, (req, res) => {
    const { promoCode, baseAmount, currency } = req.body;
    const priceInfo = calculateFinalPrice(baseAmount, currency, promoCode);

    if (priceInfo.appliedCode) {
        res.json({
            valid: true,
            code: priceInfo.appliedCode,
            currency: priceInfo.currency,
            discountPercent: priceInfo.discountPercent,
            discountAmount: priceInfo.discountAmount,
            finalPrice: priceInfo.finalPrice
        });
    } else {
        res.json({
            valid: false,
            message: 'Invalid or expired promo code.'
        });
    }
});

// ==========================================
// 6. ROUTES & EXPLICIT FILES
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/therapist-profile', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'therapist-profile.html'));
});

app.get('/therapist-profile.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'therapist-profile.html'));
});

app.get('/payment.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'payment.html'));
});

app.get('/payment-success.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'payment-success.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/payment', apiLimiter, upload.any(), handlePaymentSubmission);
app.post('/api/booking', apiLimiter, upload.any(), handleBookingSubmission);

// ==========================================
// 7. ERROR HANDLER & SERVER START
// ==========================================
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        return res.status(400).json({ success: false, error: `Upload error: ${err.message}` });
    }
    console.error('Unhandled error:', err);
    res.status(500).json({ success: false, error: 'Unexpected server error.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running live on http://localhost:${PORT}`);
});
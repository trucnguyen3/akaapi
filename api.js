require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg'); // Nếu dùng PostgreSQL
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors());

// Cấu hình kết nối PostgreSQL (Thay đổi thông số cho khớp với DB của bạn)
const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  port: 5432,
});

// 1. ĐĂNG KÝ USER (Lưu vào `demo_app_users`)
app.post('/api/auth/register', async (req, res) => {
  const { fullName, phoneNumber, email, idCardNumber } = req.body;
  try {
    const userId = 'USR_' + Date.now();
    
    // 1. Lưu thông tin user vào bảng demo_app_users
    const userQuery = `
      INSERT INTO demo_app_users (user_id, full_name, phone_number, email, id_card_number, status)
      VALUES ($1, $2, $3, $4, $5, 'ACTIVE')
      RETURNING user_id, full_name, phone_number, email;
    `;
    const userValues = [userId, fullName, phoneNumber, email, idCardNumber || null];
    const userResult = await pool.query(userQuery, userValues);
    const newUser = userResult.rows[0];

    // 2. Tự động sinh Session Token luôn cho user mới vừa đăng ký
    const token = crypto.randomBytes(32).toString('hex');
    const sessionId = 'SES_' + Date.now();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // Hạn 7 ngày

    const sessionQuery = `
      INSERT INTO demo_app_sessions (session_id, user_id, token, expires_at)
      VALUES ($1, $2, $3, $4)
    `;
    await pool.query(sessionQuery, [sessionId, userId, token, expiresAt]);

    // 3. Trả về token và thông tin để app lưu vào AsyncStorage rồi nhảy thẳng vào MainTabs
    res.json({
      success: true,
      message: 'User registered and logged in successfully',
      token: token,
      userId: newUser.user_id,
      fullName: newUser.full_name,
      phoneNumber: newUser.phone_number,
      email: newUser.email,
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, message: error.detail || 'Server error' });
  }
});

// 2. ĐĂNG NHẬP / XÁC THỰC (Kiểm tra user trong `demo_app_users`)
app.post('/api/auth/login', async (req, res) => {
  const { phoneNumber } = req.body;
  try {
    const query = `SELECT * FROM demo_app_users WHERE phone_number = $1 OR email = $1 LIMIT 1;`;
    const result = await pool.query(query, [phoneNumber]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found. Please sign up.' });
    }

    const user = result.rows[0];
    
    // Sinh token ngẫu nhiên cho phiên làm việc (Session Token)
    const token = crypto.randomBytes(32).toString('hex');
    const sessionId = 'SES_' + Date.now();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // Hạn token: 7 ngày

    // Lưu session vào bảng demo_app_sessions
    const sessionQuery = `
      INSERT INTO demo_app_sessions (session_id, user_id, token, expires_at)
      VALUES ($1, $2, $3, $4)
    `;
    await pool.query(sessionQuery, [sessionId, user.user_id, token, expiresAt]);

    res.json({
      success: true,
      token: token,
      userId: user.user_id,
      fullName: user.full_name,
      phoneNumber: user.phone_number,
      email: user.email,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/auth/verify-session', async (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }

  try {
    const query = `
      SELECT s.*, u.full_name, u.phone_number, u.email 
      FROM demo_app_sessions s
      JOIN demo_app_users u ON s.user_id = u.user_id
      WHERE s.token = $1 AND s.expires_at > CURRENT_TIMESTAMP;
    `;
    const result = await pool.query(query, [token]);

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Session expired or invalid' });
    }

    const sessionData = result.rows[0];
    res.json({
      success: true,
      userId: sessionData.user_id,
      fullName: sessionData.full_name,
      phoneNumber: sessionData.phone_number,
      email: sessionData.email,
    });
  } catch (error) {
    console.error('Verify session error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  const { token } = req.body;
  try {
    await pool.query(`DELETE FROM demo_app_sessions WHERE token = $1;`, [token]);
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// 3. LẤY THÔNG TIN PROFILE
app.get('/api/users/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const query = `SELECT user_id, full_name, phone_number, email FROM demo_app_users WHERE user_id = $1;`;
    const result = await pool.query(query, [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// 4. CẬP NHẬT PROFILE
app.put('/api/users/update', async (req, res) => {
  const { userId, fullName, phoneNumber, email } = req.body;
  try {
    const query = `
      UPDATE demo_app_users 
      SET full_name = $1, phone_number = $2, email = $3, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $4
      RETURNING *;
    `;
    const result = await pool.query(query, [fullName, phoneNumber, email, userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({ success: true, message: 'Profile updated successfully', user: result.rows[0] });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// 5. TẠO GIAO DỊCH & XỬ LÝ 1ST TRANSACTION LOGIC (Bảng `demo_app_transactions`)
app.post('/api/transactions', async (req, res) => {
  const { userId, transactionType, amount, recipientAccount, note } = req.body;
  
  try {
    // Bước A: Kiểm tra xem user đã có giao dịch thành công nào trước đó chưa bằng COUNT(*)
    const countQuery = `
      SELECT COUNT(*) AS total 
      FROM demo_app_transactions 
      WHERE user_id = $1 AND status = 'SUCCESS';
    `;
    const countResult = await pool.query(countQuery, [userId]);
    const successfulTransactionsCount = parseInt(countResult.rows[0].total, 10);

    // Nếu count == 0 nghĩa đây là giao dịch đầu tiên (isFirstTransaction = true)
    const isFirstTransaction = successfulTransactionsCount === 0;

    // Bước B: Lưu giao dịch mới vào DB
    const transactionId = 'TXN_' + Date.now();
    const insertQuery = `
      INSERT INTO demo_app_transactions 
      (transaction_id, user_id, transaction_type, amount, recipient_account, note, status, is_first_transaction)
      VALUES ($1, $2, $3, $4, $5, $6, 'SUCCESS', $7)
      RETURNING *;
    `;
    const values = [
      transactionId, 
      userId, 
      transactionType, 
      amount, 
      recipientAccount, 
      note || '', 
      isFirstTransaction
    ];

    const insertResult = await pool.query(insertQuery, values);

    // Trả kết quả về cho React Native để app phân nhánh bắn event AppsFlyer / CleverTap
    res.json({
      success: true,
      transactionId: transactionId,
      isFirstTransaction: isFirstTransaction,
      data: insertResult.rows[0],
    });
  } catch (error) {
    console.error('Create transaction error:', error);
    res.status(500).json({ success: false, message: 'Server error processing transaction' });
  }
});

// 6. ĐĂNG KÝ PHÁT HÀNH THẺ (Bảng `demo_app_card_applications`)
app.post('/api/cards/apply', async (req, res) => {
  const { userId, cardType, cardCategory, deliveryAddress, monthlyIncome } = req.body;
  try {
    const applicationId = 'CARD_' + Date.now();
    const query = `
      INSERT INTO demo_app_card_applications 
      (application_id, user_id, card_type, card_category, delivery_address, monthly_income, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
      RETURNING *;
    `;
    const values = [applicationId, userId, cardType, cardCategory, deliveryAddress, monthlyIncome];
    const result = await pool.query(query, values);

    res.json({
      success: true,
      message: 'Card application submitted successfully',
      applicationId: applicationId,
      data: result.rows[0],
    });
  } catch (error) {
    console.error('Card apply error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Khởi động Server trên cổng 3000 (hoặc cổng bạn cấu hình sau Nginx reverse proxy)
const PORT = process.env.PORT || 6967;
app.listen(PORT, () => {
  console.log(`🚀 AKA Digital UAT Server running on port ${PORT}`);
});
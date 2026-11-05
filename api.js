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
  
  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid user or amount' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // 1. Bắt đầu transaction

    // 2. Kiểm tra số dư hiện tại của user và khóa dòng (FOR UPDATE) để tránh xung đột
    const userQuery = `SELECT balance FROM demo_app_users WHERE user_id = $1 FOR UPDATE;`;
    const userResult = await client.query(userQuery, [userId]);

    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const currentBalance = parseFloat(userResult.rows[0].balance || 0);

    // 3. Kiểm tra xem tài khoản có đủ tiền để chuyển khoản không
    if (currentBalance < amount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Insufficient balance (Số dư không đủ)' });
    }

    // 4. Trừ tiền trực tiếp vào balance của user
    const updateBalanceQuery = `
      UPDATE demo_app_users 
      SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $2
      RETURNING balance;
    `;
    const updateResult = await client.query(updateBalanceQuery, [amount, userId]);
    const newBalance = updateResult.rows[0].balance;

    // 5. Kiểm tra xem user đã có giao dịch thành công nào trước đó chưa (isFirstTransaction)
    const countQuery = `
      SELECT COUNT(*) AS total 
      FROM demo_app_transactions 
      WHERE user_id = $1 AND status = 'SUCCESS';
    `;
    const countResult = await client.query(countQuery, [userId]);
    const successfulTransactionsCount = parseInt(countResult.rows[0].total, 10);
    const isFirstTransaction = successfulTransactionsCount === 0;

    // 6. Lưu lịch sử giao dịch vào bảng demo_app_transactions
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

    const insertResult = await client.query(insertQuery, values);

    await client.query('COMMIT'); // 7. Xác nhận hoàn tất transaction thành công

    // 8. (Tùy chọn) Nếu là giao dịch đầu tiên, gọi CleverTap Server API để track event
    if (isFirstTransaction) {
      try {
        const axios = require('axios');
        await axios.post('https://sg1.api.clevertap.com/1/upload', {
          "d": [
            {
              "objectId": userId,
              "type": "event",
              "evtName": "First Transaction",
              "evtData": {
                "Transaction Type": transactionType,
                "Transaction ID": transactionId,
                "Amount": amount,
                "Recipient": recipientAccount,
                "Timestamp": Math.floor(Date.now() / 1000)
              }
            }
          ]
        }, {
          headers: {
            'X-CleverTap-Account-Id': process.env.CLEVERTAP_ACCOUNT_ID,
            'X-CleverTap-Passcode': process.env.CLEVERTAP_PASSCODE,
            'Content-Type': 'application/json'
          }
        });
        console.log(`[CleverTap] Tracked 1st transaction successfully for user: ${userId}`);
      } catch (ctError) {
        // Log lỗi gửi CleverTap nhưng không làm fail request giao dịch của user
        console.error('[CleverTap API Error]:', ctError.response?.data || ctError.message);
      }
    }

    // Trả kết quả về cho React Native
    res.json({
      success: true,
      transactionId: transactionId,
      isFirstTransaction: isFirstTransaction,
      newBalance: newBalance,
      data: insertResult.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK'); // Hoàn tác nếu có lỗi xảy ra
    console.error('Create transaction error:', error);
    res.status(500).json({ success: false, message: 'Server error processing transaction' });
  } finally {
    client.release();
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

// API NẠP TIỀN (Cập nhật balance của user và ghi log vào demo_app_deposits)
app.post('/api/wallet/deposit', async (req, res) => {
  const { userId, amount } = req.body;

  if (!userId || !amount || amount <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid user or amount' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN'); // Dùng Transaction để đảm bảo tính toàn vẹn dữ liệu

    // 1. Cộng tiền vào balance của user trong demo_app_users
    const updateBalanceQuery = `
      UPDATE demo_app_users 
      SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $2
      RETURNING balance, full_name, phone_number;
    `;
    const userResult = await client.query(updateBalanceQuery, [amount, userId]);

    if (userResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const updatedUser = userResult.rows[0];

    // 2. Ghi lịch sử vào bảng demo_app_deposits
    const depositId = 'DEP_' + Date.now();
    const insertDepositQuery = `
      INSERT INTO demo_app_deposits (deposit_id, user_id, amount, status)
      VALUES ($1, $2, $3, 'SUCCESS')
      RETURNING *;
    `;
    const depositResult = await client.query(insertDepositQuery, [depositId, userId, amount]);

    await client.query('COMMIT'); // Xác nhận lưu transaction

    res.json({
      success: true,
      message: 'Deposit successful',
      depositId: depositId,
      newBalance: updatedUser.balance,
      data: depositResult.rows[0],
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Deposit error:', error);
    res.status(500).json({ success: false, message: 'Server error processing deposit' });
  }
});

app.get('/api/users/:userId', async (req, res) => {
  const { userId } = req.params;
  try {
    const query = `
      SELECT user_id, full_name, phone_number, email, balance 
      FROM demo_app_users 
      WHERE user_id = $1;
    `;
    const result = await pool.query(query, [userId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json(result.rows[0]); // Trả về object chứa cả balance
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});




// Khởi động Server trên cổng 3000 (hoặc cổng bạn cấu hình sau Nginx reverse proxy)
const PORT = process.env.PORT || 6967;
app.listen(PORT, () => {
  console.log(`🚀 AKA Digital UAT Server running on port ${PORT}`);
});
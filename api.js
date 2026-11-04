const express = require('express');
const cors = require('cors');
const { Pool } = require('pg'); // Nếu dùng PostgreSQL

const app = express();
app.use(express.json());
app.use(cors());

// Cấu hình kết nối PostgreSQL (Thay đổi thông số cho khớp với DB của bạn)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://username:password@localhost:5432/your_database',
});

// 1. ĐĂNG KÝ USER (Lưu vào `demo_app_users`)
app.post('/api/auth/register', async (req, res) => {
  const { fullName, phoneNumber, email, idCardNumber } = req.body;
  try {
    const userId = 'USR_' + Date.now(); // Sinh unique userId tự động
    const query = `
      INSERT INTO demo_app_users (user_id, full_name, phone_number, email, id_card_number, status)
      VALUES ($1, $2, $3, $4, $5, 'ACTIVE')
      RETURNING user_id, full_name, phone_number, email;
    `;
    const values = [userId, fullName, phoneNumber, email, idCardNumber || null];
    const result = await pool.query(query, values);

    res.json({
      success: true,
      message: 'User registered successfully',
      userId: result.rows[0].user_id,
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, message: error.detail || 'Server error' });
  }
});

// 2. ĐĂNG NHẬP / XÁC THỰC (Kiểm tra user trong `demo_app_users`)
app.post('/api/auth/login', async (req, res) => {
  const { phoneNumber } = req.body; // Hoặc nhận identifier (email/phone)
  try {
    const query = `SELECT * FROM demo_app_users WHERE phone_number = $1 OR email = $1 LIMIT 1;`;
    const result = await pool.query(query, [phoneNumber]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found. Please sign up.' });
    }

    const user = result.rows[0];
    res.json({
      success: true,
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
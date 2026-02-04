function generateMockEmails(count) {
  const now = new Date().toISOString();
  const emails = [];
  for (let i = 0; i < count; i += 1) {
    emails.push({
      message_id: `<test-${i}@example.com>`,
      subject: `Test Email ${i}`,
      from: "test@example.com",
      body_text: "Test body ".repeat(100),
      received_at: now
    });
  }
  return emails;
}

module.exports = { generateMockEmails };

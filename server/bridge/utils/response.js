function success(res, data, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    data,
    timestamp: new Date().toISOString(),
  });
}

function paginated(res, { data, total, limit, offset }) {
  return res.status(200).json({
    success: true,
    data,
    pagination: { total, limit, offset, hasMore: offset + limit < total },
    timestamp: new Date().toISOString(),
  });
}

function created(res, data) {
  return success(res, data, 201);
}

module.exports = { success, paginated, created };

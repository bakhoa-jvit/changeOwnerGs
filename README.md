# Drive Ownership Transfer Tool

Tool Apps Script này quét một folder Drive và toàn bộ folder con/file bên trong, tìm các item mà người chạy script đang là owner, rồi chuyển owner hoặc gửi yêu cầu chuyển owner cho email mới.

## Lưu ý khả thi

Với Google Workspace cùng tổ chức/domain, có thể transfer trực tiếp bằng permission `role=owner` + `transferOwnership=true`.

Với Gmail/consumer, script chỉ có thể tạo yêu cầu `pendingOwner=true`; người nhận phải tự chấp nhận thì owner mới thật sự đổi.

Shared drives không hỗ trợ chuyển owner kiểu này vì item thuộc về shared drive/tổ chức.

Lưu ý thêm với Gmail/consumer: email thông báo chuyển owner có thể không xuất hiện hoặc không đến ngay. Cách chắc chắn hơn là gửi link file/folder cho người nhận; người nhận mở link, vào hộp `Chia sẻ`, rồi bấm `Chấp nhận lời mời sở hữu`.

## File

- `TransferDriveOwner.gs`: logic Apps Script, checkpoint, scan, transfer owner.
- `index.html`: giao diện web app.

## Cách dùng nhanh

1. Tạo Apps Script project riêng cho tool này.
2. Thêm `TransferDriveOwner.gs` và `index.html`.
3. Bật Advanced Google service: Drive API.
4. Deploy web app với `Execute as: Me`.
5. Nhập email owner mới, Folder ID gốc, chọn chế độ transfer phù hợp rồi chạy.

## Workflow trong web app

1. Bấm `Quét owner` để quét toàn bộ cây folder.
2. Trong lúc quét, tool tự lưu checkpoint khi gần timeout và UI sẽ tự chạy tiếp sau vài giây.
3. Có thể bấm `Ngưng` để lưu checkpoint thủ công.
4. Nếu đã tìm thấy item có thể xử lý, có thể bấm `Xác nhận chuyển owner` ngay cho batch hiện tại, hoặc bấm `Tiếp tục` để quét tiếp từ checkpoint.
5. Khi quét xong, tool chuyển sang trạng thái `Chờ xác nhận`.
6. Bấm `Xác nhận chuyển owner` để bắt đầu transfer trực tiếp hoặc gửi pending owner.
7. Nếu xử lý xong batch hiện tại mà vẫn còn folder chưa quét, tool sẽ quay lại checkpoint để bạn bấm `Tiếp tục`.
8. Nếu phase xử lý owner gần timeout, tool cũng checkpoint và tự resume.

## Checkpoint

State được lưu vào một file JSON trong Drive của người chạy script, đồng thời lưu file id trong `PropertiesService`.

Nút `Xóa checkpoint` sẽ xóa state hiện tại để bắt đầu lại từ đầu. Không bấm nút này khi job đang chạy.

Nếu đóng tab web app giữa chừng, mở lại web app và nhập đúng email + Folder ID cũ rồi bấm `Quét owner`; tool sẽ nhận checkpoint cùng cấu hình và tiếp tục.

Log trong web app chỉ giữ các dòng gần nhất để state không quá lớn, nhưng có cursor nội bộ để log mới vẫn tiếp tục append đúng sau checkpoint/resume.

## Lỗi thường gặp

- `Drive is not defined`: chưa bật Advanced Google service `Drive API`.
- `Invalid field selection name`: project đang dùng Drive API v2; code phải dùng field `title`, không dùng `name`.
- `Session.getActiveUser ... userinfo.email`: dùng bản code mới nhất trong folder này. Code hiện lấy email người chạy qua `Drive.About.get()` nên không cần thêm scope `userinfo.email`.

use mytemple_server::app::decode_bytes_smart;

fn main() {
    // 测试 UTF-8 BOM
    let bom_json = b"\xef\xbb\xbf{\"name\":\"test\"}";
    let (s, enc) = decode_bytes_smart(bom_json);
    println!("BOM+JSON: enc={}, starts_with_bom={}, content={}", enc, s.starts_with('\u{feff}'), s);
    
    // 测试纯 UTF-8
    let plain_json = b"{\"name\":\"test\"}";
    let (s2, enc2) = decode_bytes_smart(plain_json);
    println!("Plain JSON: enc={}, content={}", enc2, s2);
    
    // 测试空文件
    let empty = b"";
    let (s3, enc3) = decode_bytes_smart(empty);
    println!("Empty: enc={}, len={}", enc3, s3.len());
    
    // 测试 GBK 中文
    let gbk = [0xc4u8, 0xe3, 0xba, 0xc3]; // "你好" in GBK
    let (s4, enc4) = decode_bytes_smart(&gbk);
    println!("GBK: enc={}, content={}", enc4, s4);
    
    println!("\n=== BOM 剥离测试 {} ===", if !s.starts_with('\u{feff}') { "PASS" } else { "FAIL" });
}

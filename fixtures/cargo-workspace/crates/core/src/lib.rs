/// Formats `n` in decimal without allocating through `format!`.
pub fn decimal(n: u64) -> String {
    let mut buf = itoa::Buffer::new();
    buf.format(n).to_owned()
}

#[cfg(test)]
mod tests {
    #[test]
    fn decimal_formats() {
        assert_eq!(super::decimal(42), "42");
    }
}
